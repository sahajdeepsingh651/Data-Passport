"""G1 — Account-to-bus-identity mapping.

The gateway does NOT hold any credential of its own (relay mode, see
app.py), but it needs a bus bearer token to speak to the Context Bus on
behalf of the AI-session-originated request. The Anthropic adapter (G1)
extracted `account_uuid` from the metadata Claude Code already sends; this
module maps that account_uuid to the four fields a bus call needs:
`bus_token`, `user_id`, `department`, `team`.

The mapping is a static config file mirroring `store/config/api_tokens.json`'s
shape — the hackathon-grade stand-in for the deferred `dp_*` key-issuance
model (the plan locks this: "G1's account_uuid -> token map is the
hackathon-grade stand-in").

The ONE hazardous thing about this module: an account_uuid whose token we
do not know maps to None, and downstream (G4/G6) treats None as "no bus
access" — fail-closed. Never invent a default token.

PII-adjacent: `account_uuid` is identity. Never log the raw value; `hash`
exposes only a 10-char prefix for diagnostic correlation.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

_CONFIG_PATH = Path(os.environ.get(
    "DP_IDENTITY_MAP",
    Path(__file__).resolve().parent.parent.parent / "store" / "config" / "account_map.json",
))


@dataclass(frozen=True)
class BusIdentity:
    bus_token: str
    user_id: str
    department: str
    team: str | None


_map: dict[str, dict] | None = None


def _load_map() -> dict[str, dict]:
    global _map
    if _map is None:
        if _CONFIG_PATH.exists():
            _map = json.loads(_CONFIG_PATH.read_text())
        else:
            _map = {}
    return _map


def reload_map() -> None:
    """For tests that edit the config file."""
    global _map
    _map = None


def resolve(account_uuid: str | None) -> BusIdentity | None:
    """Map an account_uuid to a BusIdentity. Returns None if the account is
    unknown or no account_uuid was sent — callers MUST treat None as
    fail-closed (no bus read, no bus write)."""
    if not account_uuid:
        return None
    entry = _load_map().get(account_uuid)
    if entry is None:
        return None
    if not all(k in entry for k in ("bus_token", "user_id", "department")):
        return None
    return BusIdentity(
        bus_token=entry["bus_token"],
        user_id=entry["user_id"],
        department=entry["department"],
        team=entry.get("team"),
    )


def account_hash(account_uuid: str | None) -> str:
    """Truncation for safe logging — PII-adjacent. A 10-char prefix is
    enough for test correlation; the full UUID is identity."""
    if not account_uuid:
        return ""
    return account_uuid[:10] + ("…" if len(account_uuid) > 10 else "")

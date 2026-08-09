"""G6 end-to-end against the LIVE Context Bus — the full demo as a test.

Session A (Engineering/platform)  submits a draft containing a credential
Session B (Engineering/mobile)    tries to read it

  1. ESDS_SUBMIT captures a draft            -> ZERO rows in the DB  (stop-ship)
  2. the credential is redacted in the draft -> and never reaches the bus
  3. ESDS_APPROVE writes exactly one row     -> with real sensitivity_flags
  4. redaction_audit_log records WHO asserted those flags        (store S3)
  5. authorship comes from the TOKEN, not the request body       (store S5)
  6. visibility=team hides it from another team
  7. --visibility org makes it visible to that team
"""
import asyncio
import json
import os
import sys
import uuid
from pathlib import Path

import asyncpg
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT))
load_dotenv(ROOT / "store" / ".env")

from gateway import bus_client, flows, pending                   # noqa: E402
from gateway.protocol.anthropic_adapter import AnthropicAdapter  # noqa: E402
from gateway.protocol.normalized import NormalizedResponse       # noqa: E402

ADAPTER = AnthropicAdapter()
SECRET = "sk-test-e2ewritekey1"
RUN = uuid.uuid4().hex[:6]
SESSION_A = f"sess-e2ew-{RUN}-a"
SESSION_B = f"sess-e2ew-{RUN}-b"

ACC_PLATFORM = "aaaaaaaa-0000-4000-8000-000000000001"     # u-dev, Engineering/platform
ACC_MOBILE = "bbbbbbbb-0000-4000-8000-000000000002"       # u-eng-2, Engineering/mobile

TOPIC = f"Redis eviction policy decision {RUN}"

DRAFT = """Here's the record.

```json
{
  "content": "Chose allkeys-lru for the session cache after benchmarking. Ops key %s is in the runbook.",
  "knowledge": {
    "title": "%s",
    "summary": "Chose allkeys-lru over volatile-ttl for the Redis session cache after benchmarking.",
    "outcome": "decision_made",
    "key_points": ["volatile-ttl evicted live sessions under load"],
    "next_steps": ["Update the runbook"]
  }
}
```
""" % (SECRET, TOPIC)


def body(text, account, session):
    meta = {"user_id": json.dumps(
        {"device_id": "d" * 8, "account_uuid": account, "session_id": session})}
    return {"model": "claude-sonnet-5", "max_tokens": 1024, "stream": True,
            "messages": [{"role": "user", "content": [{"type": "text", "text": text}]}],
            "metadata": meta}


def nr(text, account, session):
    return ADAPTER.to_normalized(body(text, account, session))


def injected(x):
    return "\n".join(b.get("text", "") for m in x.messages if m.role == "system"
                     for b in m.content if b.get("type") == "text")


async def rows(conn, session_id):
    return await conn.fetchval(
        "SELECT count(*) FROM knowledge_entries WHERE session_id = $1", session_id)


async def main():
    conn = await asyncpg.connect(os.environ["DATABASE_URL"])
    r = {}
    try:
        vault = {}

        # --- 1. submit: capture a draft, write NOTHING -------------------
        req, d1 = await flows.handle_write_request(
            nr("ESDS_SUBMIT", ACC_PLATFORM, SESSION_A), vault)
        pid = d1["pending_id"]
        rd = flows.handle_write_response(req, NormalizedResponse(
            model="claude-sonnet-5", text=DRAFT, stop_reason="end_turn", usage={}), vault)
        n_after_submit = await rows(conn, SESSION_A)
        r["1_stopship"] = rd["captured"] and n_after_submit == 0
        print(f"1. stop-ship   : captured={rd['captured']} db_rows={n_after_submit} (expect 0) -> "
              f"{'PASS' if r['1_stopship'] else 'FAIL'}")

        # --- 2. the secret is gone from the pending draft ----------------
        rec = pending.load(pid)
        stored = json.dumps(rec["draft"])
        r["2_redacted"] = SECRET not in stored and rec["sensitivity_flags"]["contains_credentials"]
        print(f"2. redacted    : secret_in_draft={SECRET in stored} "
              f"flags={rec['sensitivity_flags']} -> {'PASS' if r['2_redacted'] else 'FAIL'}")

        # --- 3. approve: exactly one row --------------------------------
        out, d3 = await flows.handle_write_request(
            nr(f"ESDS_APPROVE {pid}", ACC_PLATFORM, SESSION_A), {})
        n_after_approve = await rows(conn, SESSION_A)
        r["3_approve"] = d3["ingested"] and n_after_approve == 1
        print(f"3. approve     : ingested={d3['ingested']} record={d3['record_id']} "
              f"db_rows={n_after_approve} -> {'PASS' if r['3_approve'] else 'FAIL'}")

        row = await conn.fetchrow(
            "SELECT author_user_id, department, team, visibility, sensitivity_flags, "
            "title, summary FROM knowledge_entries WHERE session_id = $1", SESSION_A)
        # `content` is embedded, not stored as a column — so the durable
        # copies of the payload are the row's text fields and the Bronze
        # file, which is written from the raw request BEFORE validation.
        bronze_root = ROOT / "store" / "bronze"
        bronze_hits = []
        if bronze_root.exists():
            for p in bronze_root.rglob("*.json"):
                try:
                    if SECRET in p.read_text():
                        bronze_hits.append(str(p))
                except OSError:
                    pass
        in_row = SECRET in f"{row['title']} {row['summary']}"
        r["3b_no_secret_persisted"] = (not in_row) and not bronze_hits
        print(f"   secret in row={in_row} in_bronze={len(bronze_hits)} (expect False/0) -> "
              f"{'PASS' if r['3b_no_secret_persisted'] else 'FAIL'}")
        if bronze_hits:
            print(f"     LEAKED INTO BRONZE: {bronze_hits[:3]}")

        # --- 4. audit attribution (store S3) ----------------------------
        audit = await conn.fetchrow(
            "SELECT asserted_by_user_id, asserted_by_department, sensitivity_flags "
            "FROM redaction_audit_log WHERE session_id = $1 AND outcome='committed'", SESSION_A)
        flags = json.loads(audit["sensitivity_flags"]) if isinstance(
            audit["sensitivity_flags"], str) else audit["sensitivity_flags"]
        r["4_audit"] = audit["asserted_by_user_id"] == "u-dev" and flags.get("contains_credentials") is True
        print(f"4. audit attrib: asserted_by={audit['asserted_by_user_id']}/"
              f"{audit['asserted_by_department']} flags={flags} -> "
              f"{'PASS' if r['4_audit'] else 'FAIL'}")

        # --- 5. authorship from the token (store S5) --------------------
        r["5_identity"] = (row["author_user_id"] == "u-dev"
                           and row["department"] == "Engineering" and row["team"] == "platform")
        print(f"5. identity    : author={row['author_user_id']} {row['department']}/{row['team']} "
              f"visibility={row['visibility']} -> {'PASS' if r['5_identity'] else 'FAIL'}")

        # --- 6. team visibility hides it from mobile --------------------
        _, dsearch = await flows.handle_read(
            nr(f"ESDS_SEARCH {TOPIC}", ACC_MOBILE, SESSION_B), {})
        r["6_hidden"] = dsearch["hits"] == 0
        print(f"6. team-hidden : mobile hits={dsearch['hits']} (expect 0) -> "
              f"{'PASS' if r['6_hidden'] else 'FAIL'}")

        # --- 7. org visibility exposes it -------------------------------
        req2, d7a = await flows.handle_write_request(
            nr("ESDS_SUBMIT", ACC_PLATFORM, SESSION_A + "-org"), {})
        pid2 = d7a["pending_id"]
        flows.handle_write_response(req2, NormalizedResponse(
            model="claude-sonnet-5", text=DRAFT.replace(TOPIC, TOPIC + " ORG"),
            stop_reason="end_turn", usage={}), {})
        await flows.handle_write_request(
            nr(f"ESDS_APPROVE {pid2} --visibility org", ACC_PLATFORM, SESSION_A + "-org"), {})
        _, dsearch2 = await flows.handle_read(
            nr(f"ESDS_SEARCH {TOPIC} ORG", ACC_MOBILE, SESSION_B), {})
        r["7_org_visible"] = dsearch2["hits"] >= 1
        print(f"7. org-visible : mobile hits={dsearch2['hits']} (expect >=1) -> "
              f"{'PASS' if r['7_org_visible'] else 'FAIL'}")

    finally:
        await bus_client.aclose()
        for t in ("knowledge_entries", "redaction_audit_log", "context_bus_events"):
            await conn.execute(f"DELETE FROM {t} WHERE session_id LIKE 'sess-e2ew-{RUN}%'")
        await conn.close()

    print()
    bad = [k for k, v in r.items() if not v]
    print("RESULT:", "ALL PASS" if not bad else "FAILURES: " + ", ".join(bad))
    return 0 if not bad else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

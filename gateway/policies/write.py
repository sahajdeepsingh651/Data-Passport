"""WRITE policy: keyword -> inject extraction instruction -> LLM drafts a
document -> user confirms -> store.

This is a MINIMAL, test-grade implementation of the mechanism, not the real
async extraction pipeline in ARCHITECTURE.md §4 (Opus 5 + structured
outputs, dedup by subject_key, contradiction detection, a real review
queue). Two deliberate simplifications, both worth knowing before reading
this as more than a smoke test:

1. The real design extracts asynchronously, off the request's critical
   path, using the org's own extraction credential (§4.1's "tee"). This
   gateway holds no credential of its own (relay mode — see app.py), so
   there is no independent way to make a second authenticated call here.
   Instead, the extraction instruction rides in the SAME request as the
   conversation, and Claude's single reply is parsed for the extracted
   line — one round trip, not a separate async call.
2. "User confirms" is stubbed as "written to a pending-review file rather
   than auto-published" — there is no review queue UI. The point being
   proven is only that nothing publishes without a gate in between.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

from ..protocol.normalized import NormalizedRequest, NormalizedResponse
from . import read as read_policy

EXTRACTION_MARKER = "EXTRACTED_DECISION:"

_EXTRACTION_INSTRUCTION = (
    "In addition to answering normally, end your reply with a new line "
    f"starting with exactly '{EXTRACTION_MARKER} ' followed by a one-sentence "
    "summary of the main technical decision discussed in this conversation, "
    "including what was chosen and why."
)

# Test-only sink — never docs/ or fixtures/, per instruction to leave those
# untouched. A real build would write to the review-queue table instead.
_PENDING_REVIEW_DIR = Path("/tmp/dp_pending_review")


def inject_extraction_trigger(nr: NormalizedRequest) -> NormalizedRequest:
    """Add the extraction instruction to the conversation. Reuses
    read.add_context — the same 'inject authoritative content into the
    normalized conversation' primitive READ uses for retrieved documents.
    The adapter's model-aware wire-format choice (role:"system" vs the
    <system-reminder> fallback) applies here automatically, for free.
    """
    return read_policy.add_context(nr, _EXTRACTION_INSTRUCTION)


def apply(nr: NormalizedRequest, response: NormalizedResponse) -> dict | None:
    """If the response contains the extraction marker, write the extracted
    line to a pending-review file (the confirmation-gate stand-in) instead
    of publishing anywhere real. Returns the written record, or None if no
    marker was found (nothing to extract this turn).
    """
    if EXTRACTION_MARKER not in response.text:
        return None

    line = next(
        (l.strip() for l in response.text.splitlines() if l.strip().startswith(EXTRACTION_MARKER)),
        None,
    )
    if line is None:
        return None

    extracted_text = line[len(EXTRACTION_MARKER):].strip()
    record = {
        "ts": time.time(),
        "model": response.model,
        "extracted": extracted_text,
        "status": "pending_review",  # never auto-published
    }

    _PENDING_REVIEW_DIR.mkdir(exist_ok=True)
    out_path = _PENDING_REVIEW_DIR / f"{int(time.time() * 1000)}.json"
    out_path.write_text(json.dumps(record, indent=2))
    record["_path"] = str(out_path)
    return record

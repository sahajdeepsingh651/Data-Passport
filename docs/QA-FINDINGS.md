# QA findings — gateway (Track A, stub upstream)

Source: full run of `docs/QA-TEST-GUIDE.md` Track A against `gateway/app.py`
(stub upstream on :9090, gateway on :8080). Ordered most severe first.
Severity labels follow the guide's own scale (§5): critical > high > medium > low.

---

## 1. [Critical] Passthrough is not byte-identical with all policies off (T1, C9)

**Fails the guide's own sign-off condition** — every row in section T must pass.

- **Steps:** `DP_INJECT=0`, post `basic.json` (`"content": "hello there"`, a bare
  string), diff the normalized request against what the stub actually received.
- **Expected (T1):** no differences beyond key order / the always-emitted `stream` field.
- **Actual:** `content` is silently rewritten from a bare string into a block list —
  `"hello there"` → `[{"type": "text", "text": "hello there"}]` — even though CHECK's
  vault is empty and READ injection is off.
- **Root cause:** `AnthropicAdapter.to_normalized`/`_serialize_messages` normalizes
  every message unconditionally; there is no fast path that re-emits an untouched
  string as a string when nothing downstream mutated it.
- **Why it matters beyond T1 itself:** T4's cache measurement (§9) explicitly requires
  arm A to send upstream a **byte-identical** body so the prompt-cache comparison against
  "no gateway" stays valid ("A pure-passthrough gateway sends a byte-identical body
  upstream... The comparison stays honest"). This bug means that precondition is not met —
  Measurement A's arm A is not actually a faithful no-gateway baseline.
- **Reproduced via:** `post basic.json`, `diff <(jq -S . basic.json) <(jq -S . /tmp/dp_stub_last_request.json)`.

---

## 2. [High] WRITE approval-gate path never fires against the stub (W2, W4, W5, C10)

**Blocks verification of the product's core trust story** — "nothing publishes without
a human step" (§4, W4) — because the positive path can't be reproduced at all.

- **Steps:** `DP_WRITE_TEST=1`, post a message whose text is
  `EXTRACTED_DECISION: we chose Postgres over Redis for cost` (per W2's own setup).
- **Expected (W2):** one file in `/tmp/dp_pending_review/` with `status: pending_review`.
- **Actual:** no file is ever created, for any input containing the marker.
- **Root cause:** `write_policy.apply()` requires a line that **starts with** exactly
  `EXTRACTED_DECISION:`. The stub's `received_text()` always formats every block as
  `ECHO>> [user] <text>`, so the marker is always preceded by `ECHO>> [user] ` on the
  wire — the line never starts with the marker, and the match never succeeds.
- **Consequences:**
  - W4 (approval gate holds) — untestable, since no record is ever produced to inspect.
  - W5 (secret excluded from stored record) — untestable, same reason.
  - C10 (known issue #2 probe: does a restored secret leak into the pending record?) —
    untestable as scripted; the marker only ever appears mid-sentence inside the
    injected instruction text when no real message contains it, which also never
    satisfies the line-start check.
- **Fix direction (one of):** relax `write_policy.apply()`'s match to "line contains
  marker" with a trim of any prefix up to the marker, or extend the stub's echo to
  reproduce a bare marker line so Track A can actually exercise this path.

---

## 3. [Informational] Known issue #1 (coreference) — confirmed, not a new bug

- **Steps (C5):** one message containing `sk-test-aaaaaaaaaa11` twice.
- **Result:** two different tokens (`SECRET_1`, `SECRET_2`) for the same value, exactly
  as `GATEWAY-OVERVIEW.md` §8 already documents. No action needed beyond what's tracked.

---

## 4. [Informational] Known issue #3 (UTF-8 chunk boundary) — did NOT reproduce

- **Steps (C11):** stub `CHUNK = 1`, `DP_CHECK_RESTORE_STREAM=1`, post `secret_stream.json`.
- **Expected per guide:** possible dropped/replacement characters, since the relay
  decodes with `errors="ignore"`.
- **Actual:** output reassembled correctly, no mangled or replacement characters.
- **Action:** worth confirming with whoever logged known issue #3 whether this was
  already fixed, or whether it needs a narrower repro condition than 1-byte chunking.

---

## Not run

- **Track B (live)** — L1–L6 require a real Claude Code session against the actual
  Anthropic API and were not run; needs an explicit decision to spend real API usage.

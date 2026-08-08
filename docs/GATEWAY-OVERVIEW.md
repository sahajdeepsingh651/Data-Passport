# Gateway — Component Overview

**Component:** `gateway/` — the Data Passport interception gateway
**Status:** working prototype; policies are test-grade, not production
**Audience:** anyone joining the project, reviewing it, or testing it
**Companion docs:** `ARCHITECTURE.md` (the design), `TEST-PLAN.md` (the validation
ladder that decided the design), `docs/QA-TEST-GUIDE.md` (how to test this),
`docs/WIRE-FINDINGS.md` (what real traffic actually looks like)

> This document describes **what exists in the code today**. `ARCHITECTURE.md`
> describes the intended system. Where they differ, this document is right about
> the present and `ARCHITECTURE.md` is right about the destination. The
> "Maturity" table below is the map between them.

---

## 1. What this component is

A reverse proxy that sits between an AI coding harness and the model API.

```
┌──────────────┐        ┌─────────────────────┐        ┌──────────────────┐
│ Claude Code  │  POST  │   Data Passport     │  POST  │ api.anthropic.com│
│ Cursor       │───────►│      Gateway        │───────►│                  │
│ Aider, SDK…  │        │  (this component)   │        │                  │
└──────────────┘◄───────└─────────────────────┘◄───────└──────────────────┘
       ▲          SSE            │      ▲          SSE
       │                         │      │
  ANTHROPIC_BASE_URL             ▼      │
  = http://gateway         CHECK / READ / WRITE
```

The developer changes **one environment variable** and nothing else:

```bash
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

Their tool, commands, and workflow are unchanged. The tool does not know the
gateway exists.

## 2. Why a gateway and not a hook, skill, or MCP server

The binding constraint is **do not change the interface developers work in** —
anything requiring installation, invocation, or a habit gets used by the people
who already believe in it, and the brain is worthless at 10% participation.

| Mechanism | Changes the interface? | Fires reliably? | Works across harnesses? |
|---|---|---|---|
| Skill / `CLAUDE.md` | No | **No** — the model chooses | No |
| MCP tool | Per-tool config | **No** — the model chooses | No |
| Claude Code hook | No | Yes | **No** — one harness |
| **Base-URL redirect** | **No** | **Yes** | **Yes** |

Two properties only the gateway has:

1. **It sees the whole payload, not the prompt.** A `UserPromptSubmit` hook sees
   the sentence the developer typed. It never sees the config file the agent
   read three tool calls later — and that file is where credentials actually
   leak from. Confirmed in `docs/WIRE-FINDINGS.md`: a planted key lands inside a
   `tool_result` block and appears in no user-authored text.
2. **Two deployment tiers, one server.** Tier 1 is the env var — opt-in, trivial,
   and the developer can unset it. Tier 2 is network-level with a corporate CA,
   which is unbypassable and catches tools that expose no base-URL setting. Tier
   1 is the demo; tier 2 is what makes the DLP claim an enforcement boundary
   rather than a feature.

**Honest boundary:** "any harness" means any harness that runs locally *and*
exposes an endpoint setting. Browser sessions on claude.ai or chatgpt.com cannot
be redirected at all.

---

## 3. Request pipeline

Every request flows through `gateway/app.py::proxy`, the single `POST /{path:path}`
route:

```
   raw bytes
       │
       ▼
   json.loads ────────── fails ──────────┐
       │                                 │
       ▼                                 │
   detect(request, body) ── None ────────┤
       │                                 ▼
       │                        passthrough_raw()
       ▼                        forward byte-identical
   adapter.to_normalized()      (fail-open)
       │
       ▼
   ┌─────────────────────────────────┐
   │ CHECK  scan()                   │  redact secrets → vault{token: real}
   │        (unconditional)          │
   ├─────────────────────────────────┤
   │ READ   apply()                  │  if DP_INJECT and genuine human turn:
   │        (DP_INJECT)              │  append role="system" context message
   ├─────────────────────────────────┤
   │ WRITE  inject_extraction_trigger│  if DP_WRITE_TEST: append extraction
   │        (DP_WRITE_TEST)          │  instruction (same primitive as READ)
   └─────────────────────────────────┘
       │
       ▼
   adapter.from_normalized()  ← model-aware wire-format decision happens HERE
       │
       ▼
   forward to UPSTREAM
       │
       ├── stream=false ──► parse JSON → log usage → WRITE apply → CHECK restore
       │
       └── stream=true ───► relay chunks IMMEDIATELY
                            (side-buffer for usage/WRITE only)
                            → log usage → WRITE apply
```

**Ordering detail worth knowing:** on both paths, `WRITE.apply()` runs *before*
`CHECK.restore()`, so the extractor sees **redacted** text. A secret therefore
cannot be captured into a passport. This is the right behaviour; see §8 for the
one configuration where it does not hold.

---

## 4. Module map

| File | Owns | May know about wire formats? |
|---|---|---|
| `gateway/app.py` | HTTP surface, pipeline order, streaming relay, header handling, usage logging | Minimal |
| `gateway/protocol/detect.py` | Which adapter handles this request (path → schema → structure → model string) | Yes |
| `gateway/protocol/normalized.py` | `NormalizedRequest` / `NormalizedMessage` / `NormalizedResponse` | N/A (the vocabulary itself) |
| `gateway/protocol/anthropic_adapter.py` | Every Anthropic wire detail, including model gating and SSE parsing | **Yes — the only place** |
| `gateway/policies/check.py` | DLP: redact → vault → restore (incl. `StreamRestorer`) | **No** |
| `gateway/policies/read.py` | Human-turn detection, context injection | **No** |
| `gateway/policies/write.py` | Extraction trigger, marker parsing, pending-review sink | **No** |
| `gateway/tap.py` | T0 capture-only server (does not forward) | N/A |

**The architectural rule:** policies operate only on normalized types. If you
find `"anthropic"`, `cache_control`, or `content_block_delta` inside
`gateway/policies/`, that is a defect regardless of whether it works.

### The normalized layer, and why it is not over-engineering

`NormalizedRequest` deliberately reuses **Anthropic's** block vocabulary
(`text` / `tool_use` / `tool_result`) rather than inventing neutral synonyms.
Anthropic already models tool interaction *as content*, which is the property
worth making canonical. The consequence: `AnthropicAdapter` is close to an
identity transform, and a future OpenAI adapter — which models tool calls as a
separate `tool_calls` field plus `role:"tool"` messages — carries the whole
translation cost. Work is pushed onto the adapter that actually needs to do it.

`NormalizedRequest.extra` preserves every field the adapter did not model
explicitly (`max_tokens`, `tools`, `thinking`, `output_config`, beta fields…) so
`from_normalized()` round-trips losslessly. This is what stops the gateway
silently dropping request fields it does not recognise.

---

## 5. The three policies

### CHECK — the border (`policies/check.py`)

Runs **unconditionally on every request**, not behind a flag. Walks every text
block in messages and in `system` (both string and list forms), replaces matches
with an opaque token, and returns a vault mapping `token → real value`.

```
outbound:  AWS_KEY = "sk-test-abc123xyz"   →   AWS_KEY = "⟦SECRET_1⟧"
inbound:   "…the key ⟦SECRET_1⟧ is hardcoded"  →  "…the key sk-test-abc123xyz is hardcoded"
```

The design principle is **tokenise, don't delete**. A blunt `[REDACTED]` destroys
the model's ability to reason; a typed, stable token does not, because a secret's
bytes are high-entropy and carry no meaning to reason from. Type preservation,
coreference, and restore are what make this lossless — see §8 for where the
current implementation falls short of that.

Restoring on a **stream** is harder than on JSON, because a token can split
across SSE chunk boundaries (`…⟦SECRET_` in one chunk, `1⟧…` in the next).
`StreamRestorer` holds back the longest suffix that could still be the start of
a token and releases it once it is known not to be. This path is opt-in
(`DP_CHECK_RESTORE_STREAM=1`) so the default relay stays byte-for-byte
unmodified.

### READ — retrieval and injection (`policies/read.py`)

Two responsibilities:

**Turn detection.** `is_new_human_turn()` must distinguish a person asking
something from the agent looping through tool calls. A user message whose content
is entirely `tool_result` blocks is a loop hop — injecting there repeats the same
context on every hop of a multi-step tool call.

It also **looks through one trailing `role:"system"` message**, because real
Claude Code traffic routinely appends its own system message (agent list, skills,
hook output) *after* the human turn. Without this, injection silently never fires
on real traffic while passing every synthetic fixture. That was a real bug, found
against real traffic — see `docs/WIRE-FINDINGS.md`.

**Injection.** `add_context()` appends a `role="system"` message *in the
normalized representation*. That is an abstract marker meaning "authoritative,
injected context" — **it does not promise a literal `role:"system"` on the wire.**

**Retrieval is not implemented.** `DP_INJECT` / `DP_INJECT_TEXT` stand in for
"the retrieval step decided this document is relevant."

### WRITE — extraction and the approval gate (`policies/write.py`)

Appends an instruction asking the model to end its reply with
`EXTRACTED_DECISION: <one-sentence summary>`, then parses that marker out of the
response and writes it to `/tmp/dp_pending_review/<ts>.json` with
`"status": "pending_review"`.

Two deliberate shortcuts from the real design:

1. Real extraction is **asynchronous**, off the request's critical path, using
   the org's own credential. The gateway runs in relay mode and holds no
   credential, so extraction rides in the *same* request instead — one round
   trip, not a separate call.
2. "User confirms" is stubbed as "written to a pending file rather than
   published." There is no review UI. The only claim being proven is that
   **nothing publishes without a gate in between.**

The gate is not a nicety. Nobody hands their sessions to a company brain unless
they can see what leaves — approval is what makes the product adoptable, and it
is the second reason it is not merely a nice-to-have: unreviewed extraction fills
the brain with the model's guesses, and one bad week destroys trust in every
passport.

---

## 6. The injection point, and the model-gating fallback

This is the load-bearing decision in the read path.

Rewriting the top-level `system` field would change the very front of the prompt
prefix and **invalidate prompt caching for the entire conversation** — every turn
re-billed at full price. So injection always goes at the **tail of `messages[]`**,
after the cached prefix.

Anthropic supports a mid-conversation `{"role": "system", …}` message — the
non-spoofable operator channel — but **only on some models**:

```python
_SUPPORTS_MIDCONV_SYSTEM_ROLE = (
    "claude-opus-5", "claude-opus-4-8", "claude-fable-5", "claude-mythos-5",
)
```

`claude-sonnet-5` is **not** on that list, and `docs/WIRE-FINDINGS.md` confirms
Claude Code on this machine sends `claude-sonnet-5`. So on real traffic the
adapter takes the fallback path: it folds the content into the preceding user
turn as a `<system-reminder>` block.

```
supported model  →  {"role": "system",  "content": [{"type":"text","text":"…"}]}
other models     →  {"role": "user", "content": [ …original…,
                        {"type":"text","text":"<system-reminder>\n…\n</system-reminder>"} ]}
```

Same position, same cache cost, **lower trust** (user-turn text is in principle
spoofable; an operator-role message is not).

**This is the single most common source of "the test failed" reports that are
not bugs.** On Sonnet you should expect `<system-reminder>`, not `role: "system"`.

Note also that the policy layer never learns any of this. `read.py` says "append
authoritative context"; the adapter decides what that means on this wire for this
model. That separation is the point of the normalized layer — the same primitive
serves WRITE's extraction trigger for free.

---

## 7. Operational contract

### Running it

```bash
cd /home/sahaj/Projects/hackathon_agent_layer
.venv/bin/uvicorn gateway.app:app --port 8080

# separate terminal — NOT exported
ANTHROPIC_BASE_URL=http://localhost:8080 claude
```

> **Never `export ANTHROPIC_BASE_URL`** in a shell you also use for other Claude
> Code work. It redirects *all* of that shell's traffic for as long as it is set.

### Auth: relay mode

The gateway holds **no credential of its own**. It forwards whatever
`Authorization` / `x-api-key` / `anthropic-beta` headers the client already sent,
unmodified. Production `dp_*` key issuance (`ARCHITECTURE.md` §2.0) is not built.

Consequence for testing: a captured fixture replayed with `curl` carries no auth
and will 401 against the real API. Use a stub upstream — see the QA guide.

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `DP_INJECT` | `0` | `1` enables READ injection |
| `DP_INJECT_TEXT` | `Always end your reply with 🛂` | Text the READ policy injects |
| `DP_WRITE_TEST` | `0` | `1` appends the WRITE extraction instruction |
| `DP_CHECK_RESTORE_STREAM` | `0` | `1` restores redacted tokens on the SSE path |
| `DP_DEBUG_LOG_OUTBOUND` | `0` | `1` writes outbound payload to `/tmp/dp_outbound_debug_<pid>_<n>.json` and prints a `[DIAG]` line |
| `DP_ARM_LABEL` | `""` | Free-text tag written into each usage-log line |
| `DP_UPSTREAM_BASE_URL` | `https://api.anthropic.com` | Point at a stub for testing |

> `DP_DEBUG_LOG_OUTBOUND` writes the **post-redaction** payload — proving the real
> secret is absent is the point — but any *other* sensitive content in the request
> lands in `/tmp` in plaintext. Test-only.

### Artefacts written

| Path | Written by | Notes |
|---|---|---|
| `docs/usage_log.jsonl` | every request with usage | append-only; `{ts, model, injected, arm_label, usage}` |
| `fixtures/*.json` | `tap.py` | **gitignored** — may contain real secrets from `tool_result` blocks |
| `/tmp/dp_pending_review/*.json` | WRITE policy | `status: pending_review`, never auto-published |
| `/tmp/dp_outbound_debug_*.json` | debug flag only | unique file per call, never appended |

### Invariants that must not regress

1. **Never whole-response-buffer the stream.** `yield chunk` happens inside the
   `async for`, before the side-buffer append. If output arrives in one burst,
   developers unset the env var and participation goes to zero — the product dies
   at adoption, not at architecture.
2. **Fail open.** Unrecognised protocol, non-JSON body, or any policy failure
   forwards raw bytes untouched. The gateway must never be the reason a
   developer's session breaks.
3. **Never touch top-level `system`.** Cache-prefix preservation depends on it.
4. **No credential in any log line.**
5. **Policies stay wire-format-agnostic.**
6. **The real upstream status code reaches the client**, including on the
   streaming path (`app.py` uses `send(..., stream=True)` specifically so status
   is known before committing to a `StreamingResponse`).

---

## 8. Maturity — what is real, what is scaffolding

Read this before believing any capability claim.

| Capability | State | Gap to the design |
|---|---|---|
| Base-URL interception | **Working** | — |
| Streaming relay, non-buffered | **Working** | Measured ≈0.5 ms added latency against a stub |
| Byte-identical passthrough | **Working** | — |
| Protocol detect + normalize | **Working** | Anthropic only; OpenAI adapter is stub tiers in `detect.py` |
| Model-gated injection fallback | **Working** | — |
| Tool-loop guard | **Working** | — |
| Usage logging | **Working** | — |
| CHECK detection | **Test-grade** | One hardcoded pattern `sk-test-[A-Za-z0-9]{10,}`. Real suite (AWS, JWT, PAN, Aadhaar, entropy) not built |
| CHECK restore, non-streaming | **Working** | — |
| CHECK restore, streaming | **Opt-in** | Off by default; boundary handling implemented but lightly exercised |
| WRITE extraction | **Test-grade** | Same-request, marker-parsed. Not async, no structured output, no dedup |
| Approval gate | **Stubbed** | A file with `pending_review`. No queue, no UI |
| Retrieval / embeddings / Postgres | **Not built** | `DP_INJECT_TEXT` stands in for the whole retrieval step |
| Contradiction detection | **Not built** | The differentiating demo; `ARCHITECTURE.md` §4.3 |
| Identity / `dp_*` key issuance | **Not built** | Relay mode instead |
| Second wire format (OpenAI) | **Not built** | `detect.py` tiers 2–3 are comment stubs |

### Known issues and open questions

1. **Coreference is not preserved in CHECK.** `_redact_text` mints a fresh token
   per *match*, not per *value* — the same secret appearing three times becomes
   `⟦SECRET_1⟧`, `⟦SECRET_2⟧`, `⟦SECRET_3⟧`. The model can then no longer tell it
   is one key, which is often exactly the reasoning that was needed. Fix: key the
   vault by value. *(Low effort, real correctness impact.)*
2. **Restore-on-stream leaks real secrets into WRITE.** With
   `DP_CHECK_RESTORE_STREAM=1`, `parse_buf` accumulates from the *restored*
   stream, so the extractor sees real values — silently inverting the safe
   ordering described in §3. Fix: side-buffer from the raw source regardless of
   restore mode.
3. **UTF-8 chunk boundaries.** `chunk.decode("utf-8", errors="ignore")` can drop
   a character if a chunk splits a multi-byte codepoint — and the redaction token
   uses `⟦` (U+27E6, 3 bytes). Needs a deliberate probe.
4. **No stable conversation identifier** found in captured traffic. Session
   attribution and end-of-session extraction both want one. Candidate approach:
   fingerprint by hashing the first N messages — a request whose `messages` array
   extends a seen one is the same session. *Not budgeted yet.*
5. **Claude Code sends its own `role:"system"` message** on `claude-sonnet-5`.
   Whether the real API accepts that is unresolved; `tap.py` never forwards, so
   the fixture proves willingness to send, not acceptance.
6. **`cache_control` budget is nearly full.** Real traffic already places 3 of the
   API's 4 breakpoints on a *short* conversation. The `ARCHITECTURE.md` §2.2a
   fallback of placing the gateway's own breakpoint should not be assumed
   available without checking per request.
7. **Injection quality is unmeasured.** Redaction removes bytes that carry no
   meaning; bad retrieval *adds* meaning that is wrong, with no error flag and no
   attribution. A relevance floor — inject nothing below a similarity threshold —
   is a required part of the read path, not an optimisation.

---

## 9. Where to start reading

- **Understanding the bet:** `ARCHITECTURE.md` §0, then `TEST-PLAN.md` §Context.
- **Understanding the code:** `gateway/app.py::proxy` top to bottom — it is 90
  lines and the whole pipeline is visible in one function.
- **Understanding what real traffic looks like:** `docs/WIRE-FINDINGS.md`.
- **Testing it:** `docs/QA-TEST-GUIDE.md`.

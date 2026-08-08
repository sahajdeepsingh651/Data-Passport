# QA Test Guide — Data Passport Gateway

**Component under test:** `gateway/` (the interception proxy)
**Audience:** a tester with no prior knowledge of this project
**Prerequisite reading:** none — this document is self-contained
**Related:** `docs/GATEWAY-OVERVIEW.md` (what the component is),
`TEST-PLAN.md` (a *different* document — the developer's design-validation
ladder, not a QA plan)

---

## 0. What you are testing, in one paragraph

The gateway is a reverse proxy that a developer's AI coding tool talks to instead
of talking to the model API directly. It must be **invisible** (the developer must
not notice it), it must **redact secrets** on the way out and put them back on the
way in, it must **inject context** into requests without breaking them, and it
must **never break a session** even when its own logic fails. Your job is to
confirm those four things and to find the cases where they do not hold.

**The most important property is invisibility.** A gateway that is correct but
adds visible latency or makes output arrive in one burst is a failed product —
developers will switch it off. Treat any transparency failure (section **T**) as
higher severity than a policy failure.

---

## 1. Safety rules — read before running anything

| Rule | Why |
|---|---|
| **Never `export ANTHROPIC_BASE_URL`.** Always prefix it onto a single command. | Exporting redirects *all* Claude Code traffic in that shell, including unrelated work, for as long as it is set. |
| Use the **stub upstream** for everything except section **L**. | Tests are then free, deterministic, offline, and cannot leak anything to a third party. |
| Treat `fixtures/*.json` as **secret-bearing**. Do not paste them into tickets. | They are captured real request bodies and may contain real credentials. They are gitignored for this reason. |
| Only enable `DP_DEBUG_LOG_OUTBOUND=1` for the tests that require it, and clear `/tmp/dp_outbound_debug_*` afterwards. | It writes request payloads to `/tmp` in plaintext. |
| Never put a **real** credential in a test string. Use the fake `sk-test-…` shape. | The detector is built for that shape; real formats are not implemented yet. |

---

## 2. Setup

### 2.1 Two tracks

| Track | Upstream | Cost | Use for |
|---|---|---|---|
| **A — Stub** | local fake server | free, offline | Sections S, T, R, C, W, O, X (≈90% of tests) |
| **B — Live** | real Anthropic API via Claude Code | uses the developer's plan | Section L only |

Track A is the default. Do not run Track B until Track A is green.

### 2.2 Environment

```bash
cd /home/sahaj/Projects/hackathon_agent_layer
mkdir -p /tmp/dp_t
```

Verify the virtualenv exists: `.venv/bin/uvicorn --version` should print a version.

### 2.3 Create the stub upstream

Save this as `scripts/stub_upstream.py`. It records what it received, echoes the
request's text back as the reply, and streams in deliberately small, slow chunks
so that buffering and token-splitting bugs become visible.

```python
"""Stub upstream for gateway QA. Records what it received; echoes it back."""
import asyncio
import json
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, StreamingResponse

app = FastAPI()
LAST = Path("/tmp/dp_stub_last_request.json")
CHUNK = 4      # tiny, so redaction tokens split across SSE chunk boundaries
DELAY = 0.3    # slow, so whole-response buffering is obvious


def sse(event: str, data: dict) -> bytes:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n".encode()


def received_text(body: dict) -> str:
    parts = []
    for m in body.get("messages") or []:
        c = m.get("content")
        if isinstance(c, str):
            parts.append(f"[{m.get('role')}] {c}")
        elif isinstance(c, list):
            for b in c:
                if isinstance(b, dict) and b.get("type") == "text":
                    parts.append(f"[{m.get('role')}] {b.get('text', '')}")
    return " | ".join(parts)


@app.post("/{path:path}")
async def upstream(path: str, request: Request):
    raw = await request.body()
    LAST.write_bytes(raw)
    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        return JSONResponse({"stub": "non-json body received", "bytes": len(raw)})

    echo = "ECHO>> " + received_text(body)
    usage = {"input_tokens": 10, "cache_read_input_tokens": 0,
             "cache_creation_input_tokens": 0}

    if not body.get("stream"):
        return JSONResponse({
            "id": "msg_stub", "type": "message", "role": "assistant",
            "model": body.get("model"),
            "content": [{"type": "text", "text": echo}],
            "stop_reason": "end_turn",
            "usage": {**usage, "output_tokens": 5},
        })

    async def gen():
        yield sse("message_start", {"type": "message_start",
                                    "message": {"model": body.get("model"), "usage": usage}})
        for i in range(0, len(echo), CHUNK):
            await asyncio.sleep(DELAY)
            yield sse("content_block_delta", {
                "type": "content_block_delta", "index": 0,
                "delta": {"type": "text_delta", "text": echo[i:i + CHUNK]},
            })
        yield sse("message_delta", {"type": "message_delta",
                                    "delta": {"stop_reason": "end_turn"},
                                    "usage": {"output_tokens": 5}})
        yield sse("message_stop", {"type": "message_stop"})

    return StreamingResponse(gen(), media_type="text/event-stream")
```

### 2.4 Start both servers

**Terminal 1 — stub upstream (port 9090):**
```bash
cd /home/sahaj/Projects/hackathon_agent_layer
.venv/bin/uvicorn stub_upstream:app --app-dir scripts --port 9090
```

**Terminal 2 — gateway (port 8080), pointed at the stub:**
```bash
cd /home/sahaj/Projects/hackathon_agent_layer
DP_UPSTREAM_BASE_URL=http://localhost:9090 \
  .venv/bin/uvicorn gateway.app:app --port 8080
```

Terminal 2's environment changes between tests. Each test below states the exact
variables; **restart the gateway whenever they change** — they are read per
request from the process environment, so a stale process silently runs the wrong
configuration. This is the single most common cause of confusing results.

### 2.5 Test request bodies

```bash
cd /tmp/dp_t

cat > basic.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,
 "messages":[{"role":"user","content":"hello there"}],"stream":false}
EOF

cat > basic_stream.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,
 "messages":[{"role":"user","content":"hello there"}],"stream":true}
EOF

cat > secret.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,
 "messages":[{"role":"user","content":"my key is sk-test-abc123xyz789 what is wrong"}],
 "stream":false}
EOF

cat > secret_stream.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,
 "messages":[{"role":"user","content":"my key is sk-test-abc123xyz789 what is wrong"}],
 "stream":true}
EOF

cat > toolloop.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,"messages":[
  {"role":"user","content":"read config.py"},
  {"role":"assistant","content":[{"type":"tool_use","id":"tu_1","name":"Read","input":{"path":"config.py"}}]},
  {"role":"user","content":[{"type":"tool_result","tool_use_id":"tu_1","content":"AWS_KEY = 1"}]}
],"stream":false}
EOF

cat > trailing_system.json <<'EOF'
{"model":"claude-sonnet-5","max_tokens":64,"messages":[
  {"role":"user","content":"what is 2+2"},
  {"role":"system","content":[{"type":"text","text":"harness note: skills available"}]}
],"stream":false}
EOF

cat > opus.json <<'EOF'
{"model":"claude-opus-5","max_tokens":64,
 "messages":[{"role":"user","content":"hello there"}],"stream":false}
EOF
```

### 2.6 Helper

```bash
post() {  # post <file> [path]
  curl -s -N -X POST "http://localhost:8080/${2:-v1/messages}" \
    -H "content-type: application/json" \
    -H "anthropic-version: 2023-06-01" \
    --data-binary "@$1"
}
seen() { jq . /tmp/dp_stub_last_request.json; }   # what actually reached upstream
```

`jq` is required. If unavailable, substitute `python3 -m json.tool`.

---

## 3. Test cases

Each case is independent. **Expected** is the pass condition; **Fail signal**
describes what a defect looks like so you can tell a genuine bug from a
misconfiguration.

### S — Smoke

| ID | S1 |
|---|---|
| **Proves** | The gateway serves requests at all |
| **Config** | defaults |
| **Steps** | `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:8080/v1/messages -H 'content-type: application/json' -d '{}'` |
| **Expected** | Any HTTP response (200). No stack trace in Terminal 2. |
| **Fail signal** | Connection refused (gateway not running) or 500 with a traceback. |

| ID | S2 |
|---|---|
| **Proves** | Stub is reachable and recording |
| **Steps** | `post basic.json \| jq -r '.content[0].text'` then `ls -l /tmp/dp_stub_last_request.json` |
| **Expected** | Text begins `ECHO>> [user] hello there`; the recording file exists and is fresh. |
| **Fail signal** | Empty response → gateway is pointed at the real API, not the stub. Re-check `DP_UPSTREAM_BASE_URL`. |

| ID | S3 |
|---|---|
| **Proves** | Non-streaming round trip |
| **Steps** | `post basic.json \| jq .` |
| **Expected** | Valid JSON with `content`, `stop_reason`, `usage`. |

| ID | S4 |
|---|---|
| **Proves** | Streaming round trip |
| **Steps** | `post basic_stream.json` |
| **Expected** | A sequence of `event: …` / `data: …` blocks ending in `message_stop`. Text appears **progressively over ~3 s**, not all at once. |
| **Fail signal** | All output appears at once after a pause → see T2. |

---

### T — Transparency *(highest severity)*

| ID | T1 |
|---|---|
| **Proves** | With all policies off, the request is semantically unchanged |
| **Config** | `DP_INJECT=0 DP_WRITE_TEST=0` |
| **Steps** | `post basic.json > /dev/null` then `diff <(jq -S . /tmp/dp_t/basic.json) <(jq -S . /tmp/dp_stub_last_request.json)` |
| **Expected** | **No differences.** |
| **Note** | The gateway re-serialises JSON, so the bytes are *not* identical even when the content is — key order changes and `"stream"` is always emitted. `jq -S` normalises both, which is why the comparison is written this way. Do **not** use `cmp` here. |
| **Fail signal** | Any added, removed, or altered field. Report the diff verbatim. |

| ID | T2 |
|---|---|
| **Proves** | The stream is not whole-response-buffered *(adoption-critical)* |
| **Config** | defaults |
| **Steps** | `curl -s -N -o /dev/null -X POST http://localhost:8080/v1/messages -H 'content-type: application/json' --data-binary @/tmp/dp_t/basic_stream.json -w 'first_byte=%{time_starttransfer}s total=%{time_total}s\n'` |
| **Expected** | `first_byte` well under 0.5 s; `total` roughly 3 s or more. The **gap between them is the pass condition.** |
| **Fail signal** | `first_byte ≈ total` → the whole response was buffered. **Severity: critical.** |

| ID | T3 |
|---|---|
| **Proves** | Added latency is negligible |
| **Steps** | Run T2's curl five times against port **8080**, then five times against port **9090** (the stub directly). Compare median `first_byte`. |
| **Expected** | Difference < 50 ms. |
| **Fail signal** | Consistent gap > 50 ms. |

| ID | T4 |
|---|---|
| **Proves** | Query strings survive |
| **Steps** | `post basic.json 'v1/messages?beta=true&x=1' > /dev/null` and check Terminal 1's access log line. |
| **Expected** | Upstream received `/v1/messages?beta=true&x=1`. |
| **Fail signal** | Query string dropped. |

| ID | T5 |
|---|---|
| **Proves** | Fail-open on a non-JSON body |
| **Steps** | `curl -s -X POST http://localhost:8080/v1/messages -H 'content-type: text/plain' --data-binary 'not json at all'` |
| **Expected** | The stub's `{"stub":"non-json body received", …}`. The gateway forwarded raw bytes rather than erroring. |
| **Fail signal** | 500, or a JSON parse error surfaced to the client. |

| ID | T6 |
|---|---|
| **Proves** | Fail-open on an unrecognised protocol |
| **Steps** | `curl -s -X POST http://localhost:8080/v9/unknown -H 'content-type: application/json' -d '{"model":"gpt-4o","messages":[]}'` |
| **Expected** | Forwarded untouched; upstream recording shows the original body. No normalisation attempted. |
| **Note** | A body with a model starting `claude-` *is* claimed by the Anthropic adapter even on an unknown path — that is intended (detect.py tier 4). |

| ID | T7 |
|---|---|
| **Proves** | Upstream status codes reach the client on **both** paths |
| **Setup** | Temporarily edit the stub to `return JSONResponse({"error":"x"}, status_code=429)` before the stream branch; restart the stub. |
| **Steps** | Non-streaming: `curl -s -o /dev/null -w '%{http_code}\n' … @basic.json`. Streaming: same with `@basic_stream.json`. |
| **Expected** | `429` in both cases. |
| **Fail signal** | `200` on the streaming path — a real upstream error would then be invisible to the developer. Revert the stub afterwards. |

| ID | T8 |
|---|---|
| **Proves** | Hop-by-hop headers stripped, others relayed |
| **Steps** | `curl … -H 'x-marker: hello' @basic.json`; inspect Terminal 1's log / add a temporary print of `request.headers` in the stub. |
| **Expected** | `x-marker` present upstream; `host` rewritten; `content-length` matches the re-serialised body. |
| **Fail signal** | `content-length` mismatched with the actual body → a truncated or hung upstream request. |

---

### R — READ policy (context injection)

| ID | R1 |
|---|---|
| **Proves** | No injection when disabled |
| **Config** | `DP_INJECT=0` |
| **Steps** | `post basic.json > /dev/null; seen \| jq '.messages \| length'` |
| **Expected** | `1`. |

| ID | R2 |
|---|---|
| **Proves** | Injection fires on a genuine human turn |
| **Config** | `DP_INJECT=1 DP_INJECT_TEXT='PASSPORT-MARKER-42'` |
| **Steps** | `post basic.json > /dev/null; seen` |
| **Expected** | `PASSPORT-MARKER-42` appears somewhere in `.messages`. |
| **Fail signal** | Absent → check the gateway was restarted after changing the variable. |

| ID | R3 |
|---|---|
| **Proves** | Model-gating fallback on an unsupported model |
| **Config** | `DP_INJECT=1 DP_INJECT_TEXT='PASSPORT-MARKER-42'` |
| **Steps** | `post basic.json > /dev/null; seen \| jq '.messages'` (model is `claude-sonnet-5`) |
| **Expected** | **No message with `"role":"system"`.** The marker appears wrapped in `<system-reminder>…</system-reminder>` as an extra text block appended to the **user** turn. |
| **Note** | **This is correct behaviour, not a bug.** `claude-sonnet-5` does not accept mid-conversation system messages; the adapter downgrades. See `GATEWAY-OVERVIEW.md` §6. |

| ID | R4 |
|---|---|
| **Proves** | Literal system role on a supported model |
| **Config** | as R3 |
| **Steps** | `post opus.json > /dev/null; seen \| jq '.messages[-1]'` |
| **Expected** | A final message with `"role":"system"` containing the marker. No `<system-reminder>` wrapper. |

| ID | R5 |
|---|---|
| **Proves** | Tool-loop guard — the highest-value guard in the read path |
| **Config** | `DP_INJECT=1 DP_INJECT_TEXT='PASSPORT-MARKER-42'` |
| **Steps** | `post toolloop.json > /dev/null; seen \| grep -c PASSPORT-MARKER-42 \|\| echo 0` |
| **Expected** | `0` — the last turn is entirely `tool_result`, so it is a loop hop, not a person asking. |
| **Fail signal** | Marker present → context would be re-injected on every hop of a multi-step tool call. **Severity: high** (token waste + degraded output). |

| ID | R6 |
|---|---|
| **Proves** | Injection still fires past a trailing harness system message |
| **Config** | as R5 |
| **Steps** | `post trailing_system.json > /dev/null; seen \| grep -c PASSPORT-MARKER-42` |
| **Expected** | ≥ 1. Real Claude Code appends its own `role:"system"` message after the human turn; the guard must look through exactly one. |
| **Fail signal** | `0` → injection silently never fires on real traffic while passing synthetic tests. This exact bug has occurred before. |

| ID | R7 |
|---|---|
| **Proves** | Degenerate input does not crash |
| **Config** | `DP_INJECT=1` |
| **Steps** | `curl -s -X POST http://localhost:8080/v1/messages -H 'content-type: application/json' -d '{"model":"claude-sonnet-5","messages":[]}'` |
| **Expected** | A response; no traceback in Terminal 2. |

| ID | R8 |
|---|---|
| **Proves** | Top-level `system` is never modified *(cache-prefix invariant)* |
| **Config** | `DP_INJECT=1 DP_INJECT_TEXT='PASSPORT-MARKER-42'` |
| **Steps** | Add `"system":"You are a helpful assistant."` to `basic.json`, post it, then `seen \| jq '.system'` |
| **Expected** | Exactly the original string. The marker must **not** appear in `.system`. |
| **Fail signal** | Any change → prompt caching is destroyed for the whole conversation. **Severity: critical.** |

---

### C — CHECK policy (DLP)

The detector currently recognises exactly one pattern: `sk-test-` followed by
10+ alphanumerics.

| ID | C1 |
|---|---|
| **Proves** | Secrets do not cross the border |
| **Config** | defaults |
| **Steps** | `post secret.json > /dev/null; grep -c 'sk-test-abc123xyz789' /tmp/dp_stub_last_request.json \|\| echo 0; grep -o 'SECRET_[0-9]*' /tmp/dp_stub_last_request.json` |
| **Expected** | Count `0` for the real value; at least one `SECRET_1` token present. |
| **Fail signal** | The real value reaching upstream is the **most severe possible defect in this component.** |

| ID | C2 |
|---|---|
| **Proves** | `system` as a bare string is scanned |
| **Steps** | Post a body with `"system":"key is sk-test-zzzzzzzzzz11"`; inspect `seen \| jq '.system'` |
| **Expected** | Token, not the value. |

| ID | C3 |
|---|---|
| **Proves** | `system` as a block list is scanned |
| **Steps** | `"system":[{"type":"text","text":"key is sk-test-zzzzzzzzzz11"}]` |
| **Expected** | Token, not the value. |

| ID | C4 |
|---|---|
| **Proves** | Distinct secrets get distinct tokens |
| **Steps** | One message containing `sk-test-aaaaaaaaaa11` and `sk-test-bbbbbbbbbb22` |
| **Expected** | `SECRET_1` and `SECRET_2`, both real values absent. |

| ID | C5 |
|---|---|
| **Proves** | Coreference behaviour — **known deviation** |
| **Steps** | One message containing `sk-test-aaaaaaaaaa11` **twice** |
| **Expected (today)** | Two *different* tokens (`SECRET_1`, `SECRET_2`) for the same value. |
| **Action** | Record the result. Do **not** file as new — it is logged as known issue #1 in `GATEWAY-OVERVIEW.md` §8. Flag only if behaviour differs from the above. |
| **Why it matters** | The model can no longer tell it is one key, which is often the reasoning that was needed. |

| ID | C6 |
|---|---|
| **Proves** | Restore on the non-streaming path |
| **Steps** | `post secret.json \| jq -r '.content[0].text'` |
| **Expected** | The reply contains the **real** `sk-test-abc123xyz789` (the stub echoed the token back; the gateway restored it). |
| **Fail signal** | `⟦SECRET_1⟧` visible to the client → restore did not run. |

| ID | C7 |
|---|---|
| **Proves** | Streaming restore is off by default |
| **Config** | `DP_CHECK_RESTORE_STREAM=0` |
| **Steps** | `post secret_stream.json` |
| **Expected** | The token appears in the streamed text; the real value does not. |
| **Note** | **Expected behaviour, not a bug** — the default relay path is deliberately byte-for-byte unmodified. |

| ID | C8 |
|---|---|
| **Proves** | Boundary-aware streaming restore |
| **Config** | `DP_CHECK_RESTORE_STREAM=1` |
| **Steps** | `post secret_stream.json \| grep -o 'data: .*' \| …` — or simply eyeball the reassembled text |
| **Expected** | The **real** value appears in the stream, correctly reassembled even though the stub emits 4-character chunks that split the token across SSE events. |
| **Fail signal** | Mangled output, a partial token, or a duplicated fragment → `StreamRestorer` boundary handling is wrong. |

| ID | C9 |
|---|---|
| **Proves** | Zero cost when nothing matches |
| **Steps** | Repeat **T1** with the CHECK policy active (it always is). |
| **Expected** | Identical result to T1 — empty vault means every downstream step is a no-op. |

| ID | C10 |
|---|---|
| **Proves** | Restore-stream interaction with WRITE — **known defect probe** |
| **Config** | `DP_CHECK_RESTORE_STREAM=1 DP_WRITE_TEST=1` |
| **Steps** | Post `secret_stream.json`, then inspect any new file in `/tmp/dp_pending_review/` |
| **Expected (correct behaviour)** | The extracted record contains the **token**, never the real secret. |
| **Expected (today, suspected)** | The real secret may appear, because the side-buffer reads from the restored stream. |
| **Action** | Record precisely which occurs. This is known issue #2 in `GATEWAY-OVERVIEW.md` §8 — confirm or refute it. **If the secret appears, severity: high** (a credential would be persisted into the knowledge base). |

| ID | C11 |
|---|---|
| **Proves** | Multi-byte character handling across chunk boundaries |
| **Config** | `DP_CHECK_RESTORE_STREAM=1` |
| **Steps** | Set the stub's `CHUNK = 1`, restart it, post `secret_stream.json` |
| **Expected** | Output still correct. |
| **Fail signal** | Dropped or replacement characters — the redaction token uses `⟦` (3 bytes in UTF-8) and the relay decodes with `errors="ignore"`. Known issue #3; confirm or refute. Restore `CHUNK = 4` afterwards. |

---

### W — WRITE policy (extraction + approval gate)

| ID | W1 |
|---|---|
| **Proves** | Extraction trigger is injected |
| **Config** | `DP_WRITE_TEST=1` |
| **Steps** | `post basic.json > /dev/null; seen \| grep -c EXTRACTED_DECISION` |
| **Expected** | ≥ 1 — the instruction reached upstream. |

| ID | W2 |
|---|---|
| **Proves** | A marked reply produces a pending record |
| **Config** | `DP_WRITE_TEST=1` |
| **Setup** | The stub echoes the request text, so include the marker in your prompt: `"content":"EXTRACTED_DECISION: we chose Postgres over Redis for cost"` |
| **Steps** | `rm -rf /tmp/dp_pending_review; post <that file> > /dev/null; cat /tmp/dp_pending_review/*.json` |
| **Expected** | One JSON file with `extracted`, `model`, `ts`, and `"status":"pending_review"`. |

| ID | W3 |
|---|---|
| **Proves** | No marker → no record |
| **Steps** | `rm -rf /tmp/dp_pending_review; post basic.json > /dev/null; ls /tmp/dp_pending_review 2>&1` |
| **Expected** | Directory absent or empty. |

| ID | W4 |
|---|---|
| **Proves** | The approval gate holds |
| **Steps** | Inspect every file produced in W2. |
| **Expected** | **Every** record has `status: pending_review`. There must be no code path that publishes without a human step. |
| **Fail signal** | Any other status, or a write to a location outside `/tmp/dp_pending_review`. **Severity: high** — the gate is the product's trust story. |

| ID | W5 |
|---|---|
| **Proves** | Secrets cannot enter the knowledge base (non-streaming) |
| **Config** | `DP_WRITE_TEST=1`, `DP_CHECK_RESTORE_STREAM=0` |
| **Steps** | Post a non-streaming body whose text contains **both** the marker and `sk-test-abc123xyz789`; inspect the pending record. |
| **Expected** | The record contains `⟦SECRET_1⟧`, **not** the real value — `WRITE.apply()` runs before `CHECK.restore()`. |
| **Fail signal** | The real value stored. **Severity: high.** |

---

### O — Observability

| ID | O1 |
|---|---|
| **Proves** | Usage is logged on the non-streaming path |
| **Steps** | `wc -l docs/usage_log.jsonl; post basic.json > /dev/null; tail -1 docs/usage_log.jsonl \| jq .` |
| **Expected** | One new line with `ts`, `model`, `injected`, `arm_label`, `usage`. |

| ID | O2 |
|---|---|
| **Proves** | Usage is logged on the streaming path too |
| **Steps** | Same, with `basic_stream.json`. Wait for the stream to finish. |
| **Expected** | A new line appears **after** the stream completes. |
| **Fail signal** | No line → the post-stream `finally` block did not run; measurement data would be silently missing. |

| ID | O3 |
|---|---|
| **Proves** | The `injected` flag is accurate |
| **Steps** | One request with `DP_INJECT=0`, one with `DP_INJECT=1`; compare the last two log lines. |
| **Expected** | `false` then `true`. |
| **Note** | With `DP_INJECT=1` on a tool-loop body (R5) the flag must be `false` — it records whether injection *happened*, not whether it was enabled. |

| ID | O4 |
|---|---|
| **Proves** | Arm labelling works (needed for the cache measurement) |
| **Config** | `DP_ARM_LABEL=qa_run_1` |
| **Steps** | Post, inspect last log line. |
| **Expected** | `"arm_label":"qa_run_1"`. |

---

### X — Hygiene / security

| ID | X1 |
|---|---|
| **Proves** | No credential is logged |
| **Steps** | Scroll Terminal 2's full output; `grep -rE 'sk-ant|Bearer ' docs/usage_log.jsonl` |
| **Expected** | No matches anywhere. |
| **Fail signal** | Any credential fragment in logs. **Severity: critical.** |

| ID | X2 |
|---|---|
| **Proves** | Captured bodies cannot be committed |
| **Steps** | `git status --porcelain fixtures/` |
| **Expected** | No `*.json` listed as untracked-and-addable. |

| ID | X3 |
|---|---|
| **Proves** | Debug output is genuinely opt-in |
| **Steps** | `rm -f /tmp/dp_outbound_debug_*`; run several requests with the flag **unset**; `ls /tmp/dp_outbound_debug_* 2>&1` |
| **Expected** | No such files. |

| ID | X4 |
|---|---|
| **Proves** | Debug files do not collide |
| **Config** | `DP_DEBUG_LOG_OUTBOUND=1` |
| **Steps** | Send three requests; `ls /tmp/dp_outbound_debug_*` |
| **Expected** | Three distinct files, one per call. Clean up afterwards. |

---

### L — Live tests *(Track B — requires a working Claude Code login)*

Run only after Track A is green. **Terminal 2 must be restarted without
`DP_UPSTREAM_BASE_URL`** so it targets the real API.

| ID | L1 |
|---|---|
| **Proves** | A real session works end to end |
| **Steps** | In a fresh terminal: `cd /tmp/dp_t && ANTHROPIC_BASE_URL=http://localhost:8080 claude` — ask a one-line question. |
| **Expected** | A normal answer. |
| **Fail signal** | Auth errors → check relay mode is forwarding the client's headers unmodified. |

| ID | L2 |
|---|---|
| **Proves** | Streaming feels native |
| **Expected** | Tokens appear progressively, at the same pace as without the gateway. |

| ID | L3 |
|---|---|
| **Proves** | Multi-step tool use completes |
| **Steps** | Ask it to read a file and summarise it. |
| **Expected** | Tool calls run and the turn completes. |

| ID | L4 |
|---|---|
| **Proves** | Interrupt is clean |
| **Steps** | Ask for something long; press Ctrl-C mid-stream. |
| **Expected** | Returns to prompt; gateway logs no traceback; the next request works. |

| ID | L5 |
|---|---|
| **Proves** | **Invisibility** — the one criterion that cannot be a number |
| **Steps** | Do ten minutes of genuine work through the gateway. |
| **Expected** | You forget it is there. |
| **Report** | Anything you *noticed* — a pause, a stutter, a hesitation before first token — with as much detail as you can. This is the highest-value qualitative signal in the whole suite. |

| ID | L6 |
|---|---|
| **Proves** | The payload gap — why a prompt-level hook is insufficient |
| **Steps** | `mkdir -p /tmp/dp_demo && echo 'AWS_KEY = "AKIA3F7QX2MNPLKD9WZR"' > /tmp/dp_demo/config.py`. Run Claude Code against `gateway/tap.py` (port 8080) from `/tmp/dp_demo` and ask "what's wrong with config.py?". Then `grep -rl AKIA3F7QX2MNPLKD9WZR fixtures/` and inspect where it sits in the JSON. |
| **Expected** | The key appears inside a `tool_result` block and **nowhere** in user-authored text. |
| **Why** | This is the evidence for the whole architecture: the prompt was clean, the payload was not. Record the exact JSON path. |
| **Cleanup** | `rm -rf /tmp/dp_demo`. The fixture is gitignored; do not attach it to a ticket. |

---

## 4. Known limitations — do NOT report these as defects

| Observation | Status |
|---|---|
| Only `sk-test-…` is detected; real AWS keys, JWTs, PAN, Aadhaar pass through | By design today. Real detector suite is unbuilt. |
| Injected text appears as `<system-reminder>` inside the user turn on Sonnet | Correct — model gating. See `GATEWAY-OVERVIEW.md` §6. |
| Redacted token visible in a stream by default | Correct — restore is opt-in via `DP_CHECK_RESTORE_STREAM`. |
| No retrieval, embeddings, or database; injected text is a fixed env var | Not built. `DP_INJECT_TEXT` stands in for retrieval. |
| No review UI; approval is a file in `/tmp` | Stubbed deliberately. |
| Nothing detects contradictions between decisions | Not built. |
| Gateway holds no credential of its own | Relay mode, by design. |
| Only the Anthropic wire format is understood | OpenAI adapter not built. |
| Repeated identical secrets get different tokens | Known issue #1 — verify in C5, don't re-file. |

If a result is not in this table and not in §8 of the overview, it is worth
reporting.

---

## 5. Bug report template

```
ID:            <test case ID, or NEW>
Severity:      critical | high | medium | low
Track:         A (stub) | B (live)

Gateway env:   DP_INJECT=… DP_WRITE_TEST=… DP_CHECK_RESTORE_STREAM=…
               DP_UPSTREAM_BASE_URL=…
Restarted after changing env?   yes | no

Steps:         <exact commands>
Expected:      <from this document>
Actual:        <what happened>

Evidence:      <curl output, jq output, Terminal 2 traceback>
               Do NOT attach fixtures/*.json — they may contain real secrets.
Reproducible:  n/n attempts
```

**Severity guide.** *Critical* — a real secret reaches upstream, a credential is
logged, top-level `system` is modified, or the stream is buffered. *High* — the
tool-loop guard fails, the approval gate is bypassed, a secret is persisted, or
an upstream error is masked. *Medium* — a policy misbehaves without data loss.
*Low* — cosmetic or logging.

---

## 6. Results sheet

| ID | Area | Result | Notes |
|---|---|---|---|
| S1–S4 | Smoke | ☐ | |
| T1 | Passthrough unchanged | ☐ | |
| T2 | **Not buffered** | ☐ | first_byte / total: |
| T3 | Added latency | ☐ | median delta: |
| T4 | Query string | ☐ | |
| T5 | Non-JSON fail-open | ☐ | |
| T6 | Unknown protocol fail-open | ☐ | |
| T7 | Status codes both paths | ☐ | |
| T8 | Header handling | ☐ | |
| R1 | No inject when off | ☐ | |
| R2 | Inject on human turn | ☐ | |
| R3 | Sonnet fallback | ☐ | |
| R4 | Opus system role | ☐ | |
| R5 | **Tool-loop guard** | ☐ | |
| R6 | Trailing system message | ☐ | |
| R7 | Empty messages | ☐ | |
| R8 | **`system` untouched** | ☐ | |
| C1 | **Secret redacted** | ☐ | |
| C2–C4 | Coverage / multiplicity | ☐ | |
| C5 | Coreference (known) | ☐ | tokens seen: |
| C6 | Restore non-streaming | ☐ | |
| C7 | Stream restore off | ☐ | |
| C8 | Stream restore on | ☐ | |
| C10 | WRITE leak probe | ☐ | secret present? |
| C11 | UTF-8 boundary | ☐ | |
| W1–W4 | Extraction + gate | ☐ | |
| W5 | Secret not stored | ☐ | |
| O1–O4 | Usage logging | ☐ | |
| X1 | **No credential logged** | ☐ | |
| X2–X4 | Hygiene | ☐ | |
| L1–L4 | Live basics | ☐ | |
| L5 | **Invisibility** | ☐ | what you noticed: |
| L6 | Payload gap | ☐ | JSON path: |

**Sign-off condition.** Every row in **T**, plus C1, R5, R8, W4 and X1, must
pass. A failure in any of those is a stop-ship for the demo; everything else is
triage.

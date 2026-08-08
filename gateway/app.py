"""Gateway entrypoint.

Pipeline: detect protocol -> adapter.to_normalized -> CHECK -> READ -> WRITE
trigger -> adapter.from_normalized -> forward -> adapter.parse_response ->
CHECK restore -> WRITE apply -> log usage.

Auth model — RELAY MODE: the gateway does NOT hold or read any credential
of its own. It forwards whatever Authorization / x-api-key / anthropic-beta
headers the client already sent, unmodified. See TEST-PLAN.md's
"deliberately out of scope" list — production-style dp_* key issuance
(ARCHITECTURE.md §2.0) is not built here.

Run:
    uvicorn gateway.app:app --port 8080

Then, in a SEPARATE terminal (never export ANTHROPIC_BASE_URL into the shell
running an interactive Claude Code session on other projects):
    ANTHROPIC_BASE_URL=http://localhost:8080 claude

Env vars:
    DP_INJECT               "1" to enable READ-policy injection (T2/T4 test
                             scaffolding), "0"/unset to disable.
    DP_INJECT_TEXT          Text passed to the READ policy when DP_INJECT=1.
    DP_WRITE_TEST           "1" to inject the WRITE extraction trigger
                             (policies/write.py) into this request.
    DP_CHECK_RESTORE_STREAM "1" to enable boundary-aware token restoration
                             on the SSE streaming path. Off by default —
                             see the module note on relay() for why this is
                             opt-in rather than always-on.
    DP_DEBUG_LOG_OUTBOUND   "1" to write the exact outbound payload bytes
                             to /tmp/dp_outbound_debug.json before sending
                             — test-only, for proving what did/didn't leave
                             the gateway. Never enable this outside testing:
                             it writes pre-redaction... no, POST-redaction
                             payload (the whole point is to prove the real
                             secret is absent), but any other sensitive
                             content in the request would also land in that
                             file in plaintext.
    DP_ARM_LABEL            Free-text tag written into each usage log line.
    DP_UPSTREAM_BASE_URL    Override upstream base URL (test-only; defaults
                             to the real Anthropic API).
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse

from .policies import check as check_policy
from .policies import pii as pii_policy
from .policies import read as read_policy
from .policies import write as write_policy
from .protocol.detect import detect

UPSTREAM = os.environ.get("DP_UPSTREAM_BASE_URL", "https://api.anthropic.com")

# Headers we must not forward as-is (either hop-by-hop, or we're about to
# recompute them / they don't make sense to relay verbatim).
STRIP_REQUEST_HEADERS = {"host", "content-length", "connection", "accept-encoding"}

DEFAULT_INJECT_TEXT = "Always end your reply with 🛂"

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
FIXTURES_DIR.mkdir(exist_ok=True)

DOCS_DIR = Path(__file__).resolve().parent.parent / "docs"
DOCS_DIR.mkdir(exist_ok=True)
USAGE_LOG_PATH = DOCS_DIR / "usage_log.jsonl"

DEBUG_OUTBOUND_PATH = Path("/tmp/dp_outbound_debug.json")

app = FastAPI()
_client = httpx.AsyncClient(timeout=httpx.Timeout(600.0, connect=10.0))


def strip_request_headers(headers) -> dict:
    return {k: v for k, v in headers.items() if k.lower() not in STRIP_REQUEST_HEADERS}


def log_usage(*, model: str | None, injected: bool, usage: dict) -> None:
    if not usage:
        return
    entry = {
        "ts": time.time(),
        "model": model,
        "injected": injected,
        "arm_label": os.environ.get("DP_ARM_LABEL", ""),
        "usage": usage,
    }
    with open(USAGE_LOG_PATH, "a") as f:
        f.write(json.dumps(entry) + "\n")


_debug_call_counter = 0


def maybe_log_outbound(payload: bytes) -> None:
    """Test-only: write the exact bytes about to be sent upstream to a
    UNIQUE file per call (never shared/appended-to), so a test can grep for
    a given string with zero ambiguity about which call it came from or
    risk of interleaving with another call's write. Gated behind
    DP_DEBUG_LOG_OUTBOUND."""
    global _debug_call_counter
    if os.environ.get("DP_DEBUG_LOG_OUTBOUND", "0") == "1":
        _debug_call_counter += 1
        path = DEBUG_OUTBOUND_PATH.parent / f"dp_outbound_debug_{os.getpid()}_{_debug_call_counter}.json"
        path.write_bytes(payload)


def upstream_url(path: str, request: Request) -> str:
    """Forward the query string too — a reverse proxy that silently drops
    it is wrong regardless of whether any particular query param matters
    to the upstream API today."""
    url = f"{UPSTREAM}/{path}"
    query = request.url.query
    if query:
        url += f"?{query}"
    return url


async def passthrough_raw(path: str, request: Request, raw: bytes) -> Response:
    """Unrecognized protocol, or a non-JSON body: forward byte-identical,
    no normalization, no mutation. This is ARCHITECTURE.md §2.6's fail-open
    principle extended to a new failure mode — 'we don't recognize this
    wire format' gets the same treatment as a Context Bus outage.
    """
    headers = strip_request_headers(request.headers)
    headers["content-length"] = str(len(raw))
    r = await _client.post(upstream_url(path, request), content=raw, headers=headers)
    return Response(
        status_code=r.status_code,
        content=r.content,
        media_type=r.headers.get("content-type"),
    )


def _restore_text_blocks(blocks: list[dict], vault: dict) -> list[dict]:
    out = []
    for b in blocks:
        if b.get("type") == "text" and "text" in b:
            b = dict(b)
            b["text"] = check_policy.restore(b["text"], vault)
        out.append(b)
    return out


def _apply_write(nr, normalized_resp) -> None:
    result = write_policy.apply(nr, normalized_resp)
    if result:
        print(f"[WRITE] extracted -> {result}", flush=True)


async def _restore_sse_stream(raw_chunks, vault: dict):
    """Test-only streaming path (DP_CHECK_RESTORE_STREAM=1): parse complete
    SSE events, restore redacted tokens within content_block_delta text
    fields using a boundary-aware buffer (a token can split across chunk
    boundaries — see check_policy.StreamRestorer), then re-emit.

    This buffers at SSE-event granularity (waiting for a complete "\\n\\n"
    separator) rather than forwarding raw bytes the instant they arrive —
    a small, bounded amount of buffering, not the whole-response buffering
    T1 exists to rule out. It is opt-in specifically so the default relay
    path (used by every other test in this repo) stays byte-for-byte
    unchanged.
    """
    restorer = check_policy.StreamRestorer(vault)
    buf = ""
    async for chunk in raw_chunks:
        buf += chunk.decode("utf-8", errors="ignore")
        while "\n\n" in buf:
            event_text, buf = buf.split("\n\n", 1)
            yield (_process_sse_event(event_text, restorer) + "\n\n").encode()
    if buf:
        yield buf.encode()
    tail = restorer.flush()
    if tail:
        synthetic = {
            "type": "content_block_delta",
            "index": 0,
            "delta": {"type": "text_delta", "text": tail},
        }
        yield f"event: content_block_delta\ndata: {json.dumps(synthetic)}\n\n".encode()


def _process_sse_event(event_text: str, restorer) -> str:
    out_lines = []
    for line in event_text.split("\n"):
        if line.startswith("data: "):
            try:
                data = json.loads(line[len("data: "):])
            except json.JSONDecodeError:
                out_lines.append(line)
                continue
            delta = data.get("delta") or {}
            if data.get("type") == "content_block_delta" and delta.get("type") == "text_delta":
                delta["text"] = restorer.feed(delta["text"])
            out_lines.append("data: " + json.dumps(data))
        else:
            out_lines.append(line)
    return "\n".join(out_lines)


@app.post("/{path:path}")
async def proxy(path: str, request: Request):
    raw = await request.body()

    try:
        body = json.loads(raw)
    except json.JSONDecodeError:
        body = None

    adapter = detect(request, body)
    if adapter is None or body is None:
        return await passthrough_raw(path, request, raw)

    nr = adapter.to_normalized(body)

    # CHECK — scans every request unconditionally (§5: "inspect every
    # request"). vault is empty (and everything downstream a no-op) unless
    # a pattern actually matches. check.py proves the mechanism with one
    # test pattern; pii.py is the first real detector suite on top of it
    # (regex + JSON-field-aware, see its module docstring). Disjoint token
    # prefixes (SECRET_ vs PII_) mean the two vaults merge with no
    # collisions, and restore()/StreamRestorer downstream are already
    # generic over any token -> value vault, so nothing else changes.
    nr, vault = check_policy.scan(nr)
    nr, pii_vault = pii_policy.scan(nr)
    vault.update(pii_vault)

    # READ
    inject_on = os.environ.get("DP_INJECT", "0") == "1"
    inject_text = os.environ.get("DP_INJECT_TEXT", DEFAULT_INJECT_TEXT)
    is_human_turn = read_policy.is_new_human_turn(nr)
    did_inject = inject_on and is_human_turn
    if os.environ.get("DP_DEBUG_LOG_OUTBOUND", "0") == "1":
        last = nr.messages[-1] if nr.messages else None
        print(
            f"[DIAG] inject_on={inject_on} is_human_turn={is_human_turn} "
            f"did_inject={did_inject} last_role={getattr(last, 'role', None)!r} "
            f"last_block_types={[b.get('type') for b in getattr(last, 'content', [])] if last else None} "
            f"stream={nr.stream}",
            flush=True,
        )
    nr = read_policy.apply(nr, inject=inject_on, text=inject_text)

    # WRITE trigger — adds the extraction instruction to this request, same
    # injection primitive as READ.
    if os.environ.get("DP_WRITE_TEST", "0") == "1":
        nr = write_policy.inject_extraction_trigger(nr)

    out_body = adapter.from_normalized(nr)
    payload = json.dumps(out_body).encode()
    maybe_log_outbound(payload)
    headers = strip_request_headers(request.headers)
    headers["content-length"] = str(len(payload))
    url = upstream_url(path, request)
    model_name = nr.model

    if not nr.stream:
        r = await _client.post(url, content=payload, headers=headers)
        resp_json = r.json()
        normalized_resp = adapter.parse_response_json(r.status_code, resp_json)
        log_usage(model=model_name, injected=did_inject, usage=normalized_resp.usage)
        _apply_write(nr, normalized_resp)
        if vault and "content" in resp_json:
            resp_json["content"] = _restore_text_blocks(resp_json["content"], vault)
        return JSONResponse(status_code=r.status_code, content=resp_json)

    # Streaming: use the lower-level send(..., stream=True) so the response
    # status/headers are available BEFORE we commit to a StreamingResponse
    # and BEFORE any body bytes are read. The `async with client.stream()`
    # context manager can't do this — entering it and then exiting before
    # streaming would close the connection, forcing a second (duplicate,
    # costly) upstream request just to learn the status code.
    req = _client.build_request("POST", url, content=payload, headers=headers)
    r = await _client.send(req, stream=True)
    real_status = r.status_code
    restore_stream = os.environ.get("DP_CHECK_RESTORE_STREAM", "0") == "1" and bool(vault)

    async def relay():
        # `parse_buf` is a SIDE buffer used only to extract usage/text for
        # logging and WRITE. It never influences what bytes are sent to the
        # client on the default (non-restoring) path — those are forwarded
        # verbatim, immediately, from `chunk`.
        parse_buf = ""
        try:
            source = _restore_sse_stream(r.aiter_raw(), vault) if restore_stream else r.aiter_raw()
            async for chunk in source:
                yield chunk  # forward immediately — never whole-response-buffer
                try:
                    parse_buf += chunk.decode("utf-8", errors="ignore")
                except Exception:
                    continue
        finally:
            await r.aclose()
        normalized_resp = adapter.parse_response_sse(real_status, parse_buf)
        log_usage(model=model_name, injected=did_inject, usage=normalized_resp.usage)
        _apply_write(nr, normalized_resp)

    return StreamingResponse(relay(), status_code=real_status, media_type="text/event-stream")

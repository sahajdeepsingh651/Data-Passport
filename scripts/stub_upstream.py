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

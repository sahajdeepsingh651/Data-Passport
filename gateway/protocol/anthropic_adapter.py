"""Anthropic Messages API adapter.

Owns every Anthropic-wire-format detail: content-block shapes, the
mid-conversation role:"system" model-gating fallback (ARCHITECTURE.md
§2.2), and SSE/JSON response parsing. Policies never see any of this — they
only see NormalizedRequest / NormalizedResponse.
"""

from __future__ import annotations

import json

from .normalized import NormalizedMessage, NormalizedRequest, NormalizedResponse

# Models known to accept a mid-conversation {"role": "system", ...} message.
# Source: ARCHITECTURE.md §2.2, cross-checked against the Claude API
# reference's "Mid-conversation System Messages" section — both list
# exactly these four and explicitly exclude Sonnet 5. Sending the role to
# an unlisted model returns `400 role 'system' is not supported on this
# model`. Matched by prefix so dated/suffixed variants of a supported model
# still match. Keep this list in sync with both sources if either changes.
_SUPPORTS_MIDCONV_SYSTEM_ROLE = (
    "claude-opus-5",
    "claude-opus-4-8",
    "claude-fable-5",
    "claude-mythos-5",
)


def _model_supports_system_role(model: str | None) -> bool:
    if not model:
        return False
    return model.startswith(_SUPPORTS_MIDCONV_SYSTEM_ROLE)


def _content_to_blocks(content) -> list[dict]:
    """Anthropic's `content` is either a bare string or a list of content
    blocks; normalize to a list either way. Anthropic's block shapes are
    the canonical normalized vocabulary (see normalized.py's module
    docstring), so blocks pass through unchanged — this is deliberately
    close to an identity transform.
    """
    if content is None:
        return []
    if isinstance(content, str):
        return [{"type": "text", "text": content}]
    return list(content)


class AnthropicAdapter:
    name = "anthropic"

    # ---- request direction ----

    def to_normalized(self, body: dict) -> NormalizedRequest:
        extra = {k: v for k, v in body.items() if k not in {"model", "system", "messages", "stream"}}
        messages = [
            NormalizedMessage(role=m.get("role", "user"), content=_content_to_blocks(m.get("content")))
            for m in body.get("messages") or []
        ]
        return NormalizedRequest(
            model=body.get("model"),
            system_context=body.get("system"),
            messages=messages,
            stream=bool(body.get("stream")),
            metadata={"protocol": self.name},
            extra=extra,
        )

    def from_normalized(self, nr: NormalizedRequest) -> dict:
        raw = dict(nr.extra)
        raw["model"] = nr.model
        if nr.system_context is not None:
            raw["system"] = nr.system_context
        raw["messages"] = self._serialize_messages(nr)
        raw["stream"] = nr.stream
        return raw

    def _serialize_messages(self, nr: NormalizedRequest) -> list[dict]:
        """Anthropic-specific wire-format choice for injected context.

        A NormalizedMessage with role="system" is the policy layer's
        abstract "authoritative, injected context" marker — it does not
        promise a literal role:"system" message on the wire. Whether it
        survives as one depends on whether nr.model supports Anthropic's
        mid-conversation system role; when it doesn't, fold the content
        into the preceding user turn's content instead (the documented
        <system-reminder> fallback — same cache-prefix cost, lower trust,
        per ARCHITECTURE.md §2.2). The policy layer that produced this
        message never had to know any of this.
        """
        supports_system = _model_supports_system_role(nr.model)
        out: list[dict] = []
        for m in nr.messages:
            if m.role == "system" and not supports_system:
                text = "\n".join(b.get("text", "") for b in m.content if b.get("type") == "text")
                reminder = {"type": "text", "text": f"<system-reminder>\n{text}\n</system-reminder>"}
                if out and out[-1]["role"] == "user":
                    out[-1] = {"role": "user", "content": list(out[-1]["content"]) + [reminder]}
                else:
                    # No preceding user turn to fold into — shouldn't happen
                    # given policies/read.py only injects after a genuine
                    # human turn, but stay correct if it ever does.
                    out.append({"role": "user", "content": [reminder]})
                continue
            out.append({"role": m.role, "content": list(m.content)})
        return out

    # ---- response direction ----

    def parse_response_json(self, status_code: int, body: dict) -> NormalizedResponse:
        """Non-streaming response."""
        text = "".join(b.get("text", "") for b in body.get("content", []) if b.get("type") == "text")
        return NormalizedResponse(
            model=body.get("model"),
            text=text,
            stop_reason=body.get("stop_reason"),
            usage=body.get("usage") or {},
            status_code=status_code,
            is_error=status_code >= 400,
        )

    def parse_response_sse(self, status_code: int, sse_text: str) -> NormalizedResponse:
        """Streaming response — parse the accumulated SSE text after the
        fact. This is for post-hoc analysis (usage logging, future WRITE
        extraction) only — it is NOT the mechanism CHECK's real-time token
        restoration will use. Restoring redacted tokens as bytes stream
        needs an incremental, boundary-aware buffer hooked directly into
        the relay loop (a token can split across SSE chunks — see
        ARCHITECTURE.md §5's "streaming gotcha"), which is a distinct,
        not-yet-built code path.
        """
        usage: dict = {}
        text_parts: list[str] = []
        model = None
        stop_reason = None
        for line in sse_text.split("\n"):
            line = line.strip()
            if not line.startswith("data: "):
                continue
            try:
                data = json.loads(line[len("data: "):])
            except json.JSONDecodeError:
                continue
            t = data.get("type")
            if t == "message_start":
                msg = data.get("message") or {}
                model = msg.get("model", model)
                u = msg.get("usage")
                if u:
                    usage.update(u)
            elif t == "content_block_delta":
                delta = data.get("delta") or {}
                if delta.get("type") == "text_delta":
                    text_parts.append(delta.get("text", ""))
            elif t == "message_delta":
                u = data.get("usage")
                if u:
                    usage.update(u)
                sr = (data.get("delta") or {}).get("stop_reason")
                if sr:
                    stop_reason = sr
        return NormalizedResponse(
            model=model,
            text="".join(text_parts),
            stop_reason=stop_reason,
            usage=usage,
            status_code=status_code,
            is_error=status_code >= 400,
        )

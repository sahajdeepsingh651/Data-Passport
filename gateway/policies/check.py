"""CHECK policy: inspect every request -> redact confidential values ->
send the sanitized request -> restore values in the LLM response.

This is a MINIMAL, test-grade implementation — one hardcoded pattern, not
the real detector suite from ARCHITECTURE.md §5 (regex + entropy + NER for
AWS keys, JWTs, PAN, Aadhaar, etc.). It exists to prove the mechanism
(tokenize before it leaves the gateway, restore before the developer sees
the response), not to replace the Day 2 DLP build.

scan() runs unconditionally on every request — matching §5's "inspect
every request", not gated behind a test flag — but only recognizes the one
pattern below, so it is a no-op in practice except when that exact test
pattern appears.
"""

from __future__ import annotations

import re

from ..protocol.normalized import NormalizedMessage, NormalizedRequest

# A deliberately fake, test-only secret shape — never a real credential
# format. Real detectors (AWS keys, JWTs, PAN, Aadhaar, ...) are Day 2 work.
_TEST_SECRET_PATTERN = re.compile(r"sk-test-[A-Za-z0-9]{10,}")


def _redact_text(text: str, vault: dict) -> str:
    def replace(match: re.Match) -> str:
        real = match.group(0)
        token = f"⟦SECRET_{len(vault) + 1}⟧"
        vault[token] = real
        return token

    return _TEST_SECRET_PATTERN.sub(replace, text)


def scan(nr: NormalizedRequest) -> tuple[NormalizedRequest, dict]:
    """Walk every text block in the normalized request; replace matches of
    the test secret pattern with opaque tokens. Returns the (possibly
    mutated) request and a vault mapping token -> real value.

    Empty vault (the common case, when nothing matches) means restore()
    downstream is a no-op — safe to call unconditionally.
    """
    vault: dict = {}
    new_messages = []
    for m in nr.messages:
        new_content = []
        for block in m.content:
            if block.get("type") == "text" and "text" in block:
                block = dict(block)
                block["text"] = _redact_text(block["text"], vault)
            new_content.append(block)
        new_messages.append(NormalizedMessage(role=m.role, content=new_content))

    system_context = nr.system_context
    if isinstance(system_context, str):
        system_context = _redact_text(system_context, vault)
    elif isinstance(system_context, list):
        new_system = []
        for block in system_context:
            if block.get("type") == "text" and "text" in block:
                block = dict(block)
                block["text"] = _redact_text(block["text"], vault)
            new_system.append(block)
        system_context = new_system

    if not vault:
        return nr, {}

    new_nr = NormalizedRequest(
        model=nr.model,
        system_context=system_context,
        messages=new_messages,
        stream=nr.stream,
        metadata=dict(nr.metadata),
        extra=dict(nr.extra),
    )
    return new_nr, vault


def restore(text: str, vault: dict) -> str:
    """Post-hoc restore — correct for a complete string, but NOT safe to
    call per-chunk on a streaming response (a token can split across SSE
    chunk boundaries). Use StreamRestorer for that case."""
    for token, real in vault.items():
        text = text.replace(token, real)
    return text


class StreamRestorer:
    """Boundary-aware restore for text arriving in arbitrary-sized chunks.

    A token can be split across two chunks (e.g. "...⟦SECRET_" arrives in
    one chunk, "1⟧..." in the next). Naively replacing per-chunk would miss
    that match. This holds back the longest suffix that could still be the
    start of some token, and only releases it once it's known not to be
    part of one — the same technique described for restoring redacted
    tokens in ARCHITECTURE.md §5's "streaming gotcha".
    """

    def __init__(self, vault: dict):
        self.vault = vault
        self.buf = ""
        self._max_token_len = max((len(t) for t in vault), default=0)

    def feed(self, chunk: str) -> str:
        self.buf += chunk
        for token, real in self.vault.items():
            self.buf = self.buf.replace(token, real)
        keep = self._partial_suffix_len(self.buf)
        if keep == 0:
            out, self.buf = self.buf, ""
        else:
            out, self.buf = self.buf[:-keep], self.buf[-keep:]
        return out

    def flush(self) -> str:
        out, self.buf = self.buf, ""
        return out

    def _partial_suffix_len(self, s: str) -> int:
        longest = self._max_token_len
        if longest == 0 or not s:
            return 0
        for n in range(min(longest - 1, len(s)), 0, -1):
            suffix = s[-n:]
            if any(t.startswith(suffix) for t in self.vault):
                return n
        return 0

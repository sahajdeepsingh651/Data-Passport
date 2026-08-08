"""READ policy: detect a genuine human turn -> query the Context DB ->
inject the returned document into the request -> forward.

Operates ONLY on NormalizedRequest. No Anthropic/OpenAI-specific JSON
appears here — see gateway/protocol/*_adapter.py for wire-format details.

The Context DB query itself is not yet implemented (ARCHITECTURE.md §2 —
semantic retrieval is out of scope for TEST-PLAN.md's T0-T4). `apply()`
here is driven by the DP_INJECT/DP_INJECT_TEXT test scaffolding instead,
standing in for "the retrieval step decided this document is relevant."
"""

from __future__ import annotations

from ..protocol.normalized import NormalizedMessage, NormalizedRequest


def is_new_human_turn(nr: NormalizedRequest) -> bool:
    """True if the last message is a genuine human turn, not a tool-loop
    hop. A user turn whose content is entirely tool_result blocks is the
    agent continuing a tool loop, not a person asking something new —
    injecting on every hop would repeat the same context many times per
    turn.

    Real Claude Code traffic routinely ends the request with the
    harness's OWN trailing role="system" message (agent list, skills, hook
    output) appended after the actual human turn — confirmed against the
    real API, not assumed. AnthropicAdapter._serialize_messages folds any
    such message into whichever turn precedes it on the wire, so for the
    purpose of "is this a fresh turn to inject into", look through one
    trailing system message to what it will actually be attached to.
    Without this, injection silently never fires on real traffic, despite
    passing on every synthetic fixture that doesn't model this shape.
    """
    messages = nr.messages
    if not messages:
        return False
    last = messages[-1]
    if last.role == "system" and len(messages) >= 2:
        last = messages[-2]
    if last.role != "user":
        return False
    return any(b.get("type") == "text" for b in last.content)


def add_context(nr: NormalizedRequest, document_text: str) -> NormalizedRequest:
    """Append `document_text` as an authoritative, injected context turn.

    Uses role="system" in the NORMALIZED representation as the abstract
    "injected, higher-trust context" marker. Whether this survives as a
    literal system-role message on the wire, or gets rewritten into
    something else entirely, is the ADAPTER's decision at serialization
    time (see AnthropicAdapter._serialize_messages) — this function knows
    nothing about model gating or wire formats, by design. That's the
    point: "append to the last user message" is not the universal
    mechanism; "modify the normalized conversation" is, and the adapter
    picks the valid wire-format location.
    """
    injected = NormalizedMessage(role="system", content=[{"type": "text", "text": document_text}])
    return nr.clone_with_messages(list(nr.messages) + [injected])


def apply(nr: NormalizedRequest, *, inject: bool, text: str) -> NormalizedRequest:
    if inject and is_new_human_turn(nr):
        return add_context(nr, text)
    return nr

# Data Passport — Core Service Definition (Ingest → Context Bus → Serving)

> Status: DRAFT — this is what we build first for the PoC. Scope decided 2026-08-07, see `decisions-log.md`.

## 1. Scope of this doc

The boundary drawn for the first build: everything from the moment a request **arrives** at our server (content has already left some endpoint, by whatever mechanism) through to the moment a response/notification **leaves** our server toward whichever endpoint needs it.

Explicitly **not** covered here — owned by the team, still open, tracked in `data-passport-security-egress.md` §4–5:

- How content is captured at the origin endpoint and sent to us (browser extension, network proxy, IDE/CLI plugin, or manual dashboard entry).
- How content is consumed/displayed/injected at the destination endpoint once we hand it back (dashboard render, browser injection, IDE sidebar, etc.).

Every endpoint-side mechanism, whichever one the team lands on, talks to the core exclusively through the two contracts in §3 and §5. That's deliberate: it lets the endpoint mechanism be decided and built in parallel without the core changing, and it means the core is demoable standalone (via curl/Postman/a basic MCP client) before any endpoint software exists at all.

## 2. The flow, end to end

```
[ any endpoint, capture mechanism TBD ]
        │  on-device: detect PII/secrets → redact (never transmitted raw — see
        │  data-passport-architecture.md § The Endpoint Checkpoint)
        │  POST /v1/ingest  (already-redacted content + sensitivity_flags metadata)
        ▼
   INGEST API  ── writes payload, untouched, to BRONZE
        │
        ▼
     THE GATE   (sync, in-request): validate domain_data types →
                tag provenance → structure/extract → audit log (from reported flags)
        │
        ├──X quarantined → stays in Bronze only, audit entry, 422 response
        │
        ▼
      SILVER  (Postgres: knowledge_entries, redaction_audit_log)
        │
        ▼
       GOLD   (Postgres + pgvector: embeddings, agent_activity, aggregates)
        │
        ▼
  CONTEXT BUS  (Postgres table + LISTEN/NOTIFY channel)
        │
        ├──► SERVING (pull): search_knowledge / get_agent_activity / handoff
        └──► SERVING (push): /v1/bus/subscribe  (SSE)
                │
                ▼
     [ any endpoint that needs it, consumption mechanism TBD ]
```

Same Bronze/Gate/Silver/Gold shape already agreed in `data-passport-architecture.md`. This doc makes the two outer edges (ingest, serving) concrete enough to build against, and turns the Context Bus from a named concept into an actual mechanism.

**The core never scans for or stores raw PII.** Detection and redaction happen entirely on the endpoint, before the `POST /v1/ingest` call is even made — the core service described in this doc has no PII-detection dependency at all. That's a deliberate, confirmed team decision (zero server-side scanning, no defense-in-depth re-check) — see `decisions-log.md`.

## 3. Ingress contract — how data enters the core

**`POST /v1/ingest`**

Single entry point. Every capture mechanism — MCP's `record_insight` tool, a future proxy, a future browser extension, a manual dashboard form — is just a caller of this one endpoint. `record_insight` is a thin wrapper that calls it internally, not a separate code path.

Request body — content is already redacted by the caller before this call is made:

```jsonc
{
  "source_system": "claude-code",        // required — which tool/system produced this
  "captured_by": { "user_id": "...", "agent_id": "..." },
  "content": "...",                       // session transcript/content — REQUIRED to already be PII/secret-free; the core does not scan it
  "sensitivity_flags": {                  // reported by the endpoint's own detector — metadata only, never raw flagged values
    "contains_pii": true,
    "contains_credentials": false,
    "redaction_applied": true,
    "redaction_count": 3
  },
  "hint": {                               // optional, best-effort from the caller — Gate re-derives/validates, never trusted blindly
    "department": "Engineering",
    "team": "..."
  }
}
```

Response:

- `201 { record_id, gold_ref, sensitivity_flags, status: "committed" }` — passed the Gate, now live in Silver/Gold and on the Context Bus.
- `422 { error, field, quarantine_id, status: "quarantined" }` — failed Gate validation (bad `domain_data` type, or content that can't be structured). Raw payload stays in Bronze for human review; nothing downstream happens automatically. Never a PII-related rejection — the core doesn't check for that (see the note above).

Auth: bearer token identifying the calling service/user — enough to stamp provenance and enforce the admin-floor consent rules (`data-passport-architecture.md` § Consent model). Nothing more elaborate for the hackathon.

Processing inside the request is **synchronous** — no queue/worker. Same "fewer moving parts" call already made for keeping Silver/Gold in one Postgres instance (`decisions-log.md`). A queue is easy to add later if Gate processing gets slow; not needed at hackathon volume.

## 4. The Context Bus, concretely

Previously named in `data-passport-architecture.md` but not mechanically defined. For this build:

- **Durable log** — a `context_bus_events` Postgres table, one row per committed record, holding exactly the compact projection already defined in `data-passport-schema.md` §5 (`record_id, session_id, department/team, agent_id, event_type, title/summary, status, visibility, timestamp, gold_ref`). Append-only.
- **Real-time push** — the same write also does `NOTIFY context_bus, '<event json>'` (Postgres LISTEN/NOTIFY). Any connected subscriber gets it instantly; no polling.
- **Replay/catch-up** — a subscriber that was offline queries the table (`WHERE timestamp > last_seen`) to catch up, then resumes listening. At-least-once delivery without Kafka/Redis — Postgres stays the only piece of infrastructure, consistent with the existing storage decision.

Everything downstream (search, activity feed, dashboard, a future proxy wanting fresh context) reads from this one stream/table rather than each inventing its own notion of "what's new."

## 5. Egress/serving contract — how data reaches the endpoint that needs it

Two consumption modes over the same data:

**Pull — REST and MCP, one implementation**

- `GET /v1/search?q=...` — semantic + keyword search across Gold.
- `GET /v1/agent-activity?team=...|project=...` — current agent activity ledger.
- `GET /v1/handoff/{session_id}` — full context of a session another agent left off.
- The MCP tools already named in `data-passport-architecture.md` §4 (`search_knowledge`, `get_agent_activity`, `handoff`) are thin wrappers over these same three REST calls — one implementation, two protocol faces, so an endpoint that can't speak MCP (a browser extension, a proxy) still has a plain HTTP way in.

**Push — SSE subscription**

- `GET /v1/bus/subscribe?department=...&team=...&visibility=...` — long-lived connection streaming Context Bus events matching the filter, as they're committed. For any endpoint software that wants to react live (a dashboard feed today; a future proxy injecting fresh context into a browser session, or an IDE notification, later) — without that consumer needing to know anything about Postgres or LISTEN/NOTIFY.

`visibility` (`private/team/department/org`) is enforced at both the REST/MCP query layer and the SSE filter — a caller only ever receives what its identity is allowed to see.

## 6. Left open, on purpose

- Origin-side capture mechanism (browser extension / network proxy / IDE plugin / manual dashboard entry) — `data-passport-security-egress.md` §4–5, unconfirmed. Whatever it ends up being, it only needs to be able to `POST /v1/ingest` with already-redacted content.
- **The PII/secret detection & redaction engine itself** — lives inside whichever origin-side mechanism above gets built, per `data-passport-architecture.md` § The Endpoint Checkpoint. It is not part of the core service defined in this doc.
- Destination-side consumption/injection mechanism (how retrieved context actually shows up for a human, or gets injected into a live session) — same open status; the interface it needs is just §5's REST/MCP calls or the `/v1/bus/subscribe` stream.
- Auth model beyond a bearer token (SSO, finer-grained per-team scoping) — fine as-is for the hackathon, real design deferred.

## 7. Build order

1. Postgres schema: `knowledge_entries`, `redaction_audit_log`, `agent_activity`, `context_bus_events`, `knowledge_embeddings`.
2. `POST /v1/ingest` with a stub Gate (provenance tagging + `domain_data` validation only — no redaction here, that's endpoint-side and out of scope for the core) — one record end-to-end into Silver/Gold.
3. Context Bus write + `NOTIFY` on every commit.
4. `GET /v1/search`, `/v1/agent-activity`, `/v1/handoff` (REST first — the MCP wrapper is a thin layer on top once these work).
5. `GET /v1/bus/subscribe` (SSE).
6. MCP tool wrappers around step 4's endpoints.

This order gets a demoable slice — ingest one thing, search for it, watch it appear on the bus — working before any endpoint-side software needs to exist.

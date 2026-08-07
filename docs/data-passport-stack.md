# Data Passport — Stack & Build Log

> Status: **LIVING DOC.** Two jobs, kept separate:
> 1. **§1 Stack** — the current, concrete tech choices, one row per component. No reasoning/trade-off prose here — that belongs in `decisions-log.md`; this table just says what we're using.
> 2. **§3 Build Log** — appended to every time something is actually implemented. A row only goes in once code exists and runs, not when something is merely planned.
>
> Update this file in the same commit/session as the work it describes — don't reconstruct it later from memory.

## 1. Stack by component

| Layer / component | Tech | Status | Defined in |
|---|---|---|---|
| Bronze (raw storage) | Folder structure or MinIO (S3-compatible object storage) | Decided | `data-passport-architecture.md` §3 |
| Silver (structured records) | PostgreSQL | Decided | `data-passport-architecture.md` §3 |
| Gold (search index) | PostgreSQL + `pgvector` extension | Decided | `data-passport-architecture.md` §3 |
| Embeddings | "A standard embedding API call" | **Open** — provider/model not chosen | `data-passport-architecture.md` §6 |
| Context Bus | Postgres table (`context_bus_events`) + `LISTEN`/`NOTIFY` | Decided | `data-passport-core-service.md` §4 |
| Ingest API | REST, single `POST /v1/ingest`, synchronous (no queue/worker) | Decided (contract) — **Open**: language/framework | `data-passport-core-service.md` §3 |
| Serving API | REST (`/v1/search`, `/v1/agent-activity`, `/v1/handoff`) + MCP wrapper + SSE (`/v1/bus/subscribe`) | Decided (contract) — **Open**: language/framework, MCP SDK | `data-passport-core-service.md` §5 |
| Endpoint Checkpoint (PII/secret detection) | Regex + gitleaks-style patterns (secrets); regex + lightweight NER e.g. Presidio (PII) | Decided (approach) — **Open**: runtime/language; owned by whichever endpoint mechanism gets built | `data-passport-architecture.md` § The Endpoint Checkpoint |
| Endpoint capture/consumption mechanism | Browser extension / network proxy / IDE plugin / manual dashboard entry | **Open** — not yet chosen | `data-passport-security-egress.md` §4–5 |
| Dashboard | Web dashboard | **Open** — framework not chosen | `data-passport-architecture.md` §4 |
| Auth | Bearer token | Decided (mechanism) — **Open**: issuance/storage details | `data-passport-core-service.md` §3 |
| Deployment | "A VM" | **Open** — provisioning not chosen (bare VM / Docker Compose / etc.) | `data-passport-architecture.md` §6 |

## 2. Open stack decisions (blocking implementation)

1. Backend language/framework for the ingest + serving API.
2. Embedding provider/model.
3. Frontend framework for the dashboard.
4. MCP server SDK.
5. Deployment target — bare VM, Docker Compose, etc.
6. Endpoint-side runtime — whatever language the browser extension / proxy / IDE plugin ends up in; blocked on the interception-mechanism decision itself (`data-passport-security-egress.md` §5), not on this doc.

## 3. Build log

*(empty — nothing built yet)*

| Date | Component | What was built | Tech / library (+ version) | Where (path / PR) | Notes |
|---|---|---|---|---|---|

## How to update this doc

- **Every time you build something real**, add a row to §3 with: date, which component it is, a one-line description of what got built, the exact tech/library (with version), and where it lives (file path or PR link).
- If that work also **locks in a stack choice** that was previously "Open" in §1, update that row's Status to "Built" (or "Decided" if chosen but not yet coded) and fill in the Tech column.
- If the choice involved a real trade-off (e.g., picking Postgres over a dedicated vector DB, or one language over another), record the reasoning in `decisions-log.md` and just link to it from here — don't duplicate reasoning in this doc.

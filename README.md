# Data Passport (ESDS Hackathon Project)

Knowledge that should move across the org doesn't. Data that shouldn't move (PII, credentials, confidential/financial data) does. Data Passport fixes both, using a single endpoint-level checkpoint that strips PII/credentials before anything leaves the device — whether it's headed to our own knowledge base or to external AI — plus a data lakehouse that structures and serves what's left.

## Docs index

| Doc | Covers |
|---|---|
| [`data-passport-problem-analysis.md`](data-passport-problem-analysis.md) | The original problem statement broken into sub-problems, and which ones we're actually solving vs. deferring |
| [`data-passport-architecture.md`](data-passport-architecture.md) | The medallion lakehouse design (Bronze → Gate → Silver → Gold), MCP serving layer, team split |
| [`data-passport-core-service.md`](data-passport-core-service.md) | What we're building first for the PoC — the concrete ingest API, Context Bus mechanism, and serving API, with the endpoint-side capture/consumption mechanism left as an open, pluggable boundary |
| [`data-passport-stack.md`](data-passport-stack.md) | Living doc — the concrete tech stack per component, open stack decisions, and a build log updated every time something is actually implemented |
| [`data-passport-schema.md`](data-passport-schema.md) | The session-extraction schema — what gets pulled out of an AI session, generalized across departments |
| [`data-passport-security-egress.md`](data-passport-security-egress.md) | The endpoint-level checkpoint — blocking/redaction of PII, credentials, and confidential data before anything leaves the device, whether bound for Data Passport's own ingest API or external AI |
| [`glean-research.md`](glean-research.md) | SOTA analysis — how Glean (closest mature analog) is architected, what we adopted, what we didn't |
| [`decisions-log.md`](decisions-log.md) | Every architectural/design decision made, with reasoning and rejected alternatives — updated as we go |

## Current status

- Architecture, schema, and security design: drafted, one round of SOTA-informed revision done, plus a policy-configuration model (admin floor / employee ceiling) applied across both gates.
- PII/credential detection & redaction relocated entirely to the endpoint device (2026-08-07) — the central system never scans for or stores raw PII; it trusts endpoint-reported `sensitivity_flags` metadata only. See `data-passport-architecture.md` § The Endpoint Checkpoint and `data-passport-security-egress.md`.
- PoC build has started: core service scope defined (`data-passport-core-service.md`) — ingest API → Gate → Silver/Gold → Context Bus → serving (REST + MCP + SSE). Endpoint-side capture/consumption mechanism intentionally left open and decoupled behind a plain HTTP contract; the core has no PII-detection dependency of its own.
- Open items: concrete PII/confidential-data regex rules not yet written (categories only); Egress Gate interception mechanism (local proxy vs. browser extension vs. IDE plugin) proposed but not confirmed; concrete admin-floor list (which destinations/categories/session-types are actually mandatory) not yet defined, just the mechanism for defining them — see `data-passport-security-egress.md`; MCP alternatives for connector integration not yet evaluated.

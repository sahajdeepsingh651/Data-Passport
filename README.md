# Data Passport (ESDS Hackathon Project)

Knowledge that should move across the org doesn't. Data that shouldn't move (PII, credentials, confidential/financial data) does. Data Passport fixes both, using a data lakehouse where the layer boundaries themselves act as passport control, plus an endpoint-level checkpoint for anything headed to external AI.

## Docs index

| Doc | Covers |
|---|---|
| [`data-passport-problem-analysis.md`](data-passport-problem-analysis.md) | The original problem statement broken into sub-problems, and which ones we're actually solving vs. deferring |
| [`data-passport-architecture.md`](data-passport-architecture.md) | The medallion lakehouse design (Bronze → Gate → Silver → Gold), MCP serving layer, team split |
| [`data-passport-schema.md`](data-passport-schema.md) | The session-extraction schema — what gets pulled out of an AI session, generalized across departments |
| [`data-passport-security-egress.md`](data-passport-security-egress.md) | The Egress Gate — endpoint-level blocking/redaction of PII and confidential data before it reaches external AI |
| [`glean-research.md`](glean-research.md) | SOTA analysis — how Glean (closest mature analog) is architected, what we adopted, what we didn't |
| [`decisions-log.md`](decisions-log.md) | Every architectural/design decision made, with reasoning and rejected alternatives — updated as we go |

## Current status

- Architecture, schema, and security design: drafted, one round of SOTA-informed revision done, plus a policy-configuration model (admin floor / employee ceiling) applied across both gates.
- Open items: concrete PII/confidential-data regex rules not yet written (categories only); Egress Gate interception mechanism (local proxy vs. browser extension vs. IDE plugin) proposed but not confirmed; concrete admin-floor list (which destinations/categories/session-types are actually mandatory) not yet defined, just the mechanism for defining them — see `data-passport-security-egress.md`; MCP alternatives for connector integration not yet evaluated.
- Nothing built yet — still in design/planning phase.

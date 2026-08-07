# Data Passport — Architecture Doc (Medallion Lakehouse)

## 1. The idea in one line

Knowledge that should move across the org doesn't. Data that shouldn't move (PII, credentials, customer data) does. **Data Passport fixes both at once**, using a data lakehouse where the layer boundaries themselves act as passport control.

> Updated 2026-08-07 with ideas adopted from researching Glean's architecture — see `glean-research.md` for full findings and what we chose not to copy.

## 2. Background: warehouse vs. lake vs. lakehouse

| Pattern | Storage model | Strength | Weakness for us |
|---|---|---|---|
| Data Warehouse | Structured, schema-on-write (tables) | Fast to query, dashboard-friendly | Org knowledge isn't clean rows — it's chat logs, docs, decisions in prose. Forces ingestion adapters before anything lands. |
| Data Lake | Raw files/blobs, schema-on-read | Captures everything cheaply, no upfront schema | No natural checkpoint to enforce PII/credential redaction. Search and governance on raw data is weak. |
| Data Lakehouse | Raw layer + governed curated layer + serving layer (medallion: Bronze/Silver/Gold) | Combines both: cheap raw capture AND a governed, queryable curated layer | Full versions (Iceberg/Delta + Spark/Trino) are heavy for a hackathon. We use a lightweight version. |

We're using the **lakehouse / medallion pattern**, lightly implemented, because the layer transitions map directly onto the "passport" metaphor.

## 3. The three layers

### Bronze — Raw / Unfiltered

- Everything lands here exactly as captured: agent conversation logs, meeting notes, Slack/doc exports, decision write-ups, code review comments — whatever a team or an AI agent produces.
- Schema-on-read: no validation, no redaction, no structure enforced. This is intentional — capture must be zero-friction or people/agents won't feed it.
- **This layer still contains PII and credentials.** It has NOT crossed passport control yet.
- Storage: a folder structure or MinIO (S3-compatible object storage) bucket on the VM, partitioned by date/team/source, e.g. `bronze/{team}/{source}/{yyyy-mm-dd}/{id}.json`.

### The Gate — Bronze → Silver (Passport Control)

This is the literal checkpoint. Nothing reaches Silver without passing through it.

1. **PII / credential detection** — regex + pattern matching for secrets (API keys, tokens, connection strings — gitleaks-style patterns) and PII (emails, phone numbers, names, customer IDs — regex plus a lightweight NER pass, e.g. Presidio).
2. **Redaction / tokenization** — flagged spans are stripped or replaced with placeholders (`[REDACTED_EMAIL]`), not silently deleted — the fact that something was caught is itself useful signal.
3. **Provenance tagging** — every record is stamped with team, author, agent/session ID, source system, and timestamp before moving on.
4. **Audit logging** — every catch (what was flagged, what rule matched, which record) is written to a `redaction_audit_log`. This is your demo evidence: "here's what tried to cross the border and didn't."
5. **Structuring / extraction** — raw text is turned into a knowledge record: title, summary, tags, team, links to source.

Anything that fails the gate is quarantined (stays in Bronze, flagged) rather than blocked silently — someone can review and override.

### Silver — Cleaned, Structured, Safe

- One record per captured insight/decision/session, PII-free, tagged with provenance.
- Deduplicated against near-identical recent entries (this is also where a contradiction-detection pass could later hook in, as a stretch feature).
- Storage: PostgreSQL tables (`knowledge_entries`, `redaction_audit_log`, `agent_sessions`).

### Gold — Curated, Indexed, Servable

- Silver records get embedded (vector representation of their content) and indexed for semantic search, not just keyword search.
- Aggregated views built here: a team knowledge base, a cross-team decision registry, an "agent activity ledger" (what any AI agent is working on right now, and what it left off with — enabling another agent/session to pick up where it stopped).
- Storage: PostgreSQL + `pgvector` extension — same database as Silver, just additional tables/indexes (`knowledge_embeddings`, `agent_activity`). Keeping Silver and Gold in one Postgres instance keeps the VM setup to a single service.
- **Ranking is plain vector similarity** (`ORDER BY embedding <=> query_embedding`) — no relevance index needed at hackathon data volume (tens–low hundreds of records). Glean's hybrid ranking (vector + graph-relationship + activity signals) was considered and reverted on 2026-08-07: it solves a relevance problem that only shows up at Glean's scale (billions of docs), and building/tuning a scoring formula for it would spend hackathon time on a problem the demo doesn't actually have. Revisit post-hackathon if the knowledge base grows large enough for plain vector ranking to start returning noisy results.

### Consent model — which sessions actually get linked to the passport

Resolved 2026-08-07 (previously an open question, see `decisions-log.md`). Not every session a user or agent runs becomes a permanent Silver/Gold record — whether it does is governed by consent, not automatic capture:

- **Admin policy sets a mandatory floor.** Certain categories are always captured regardless of individual choice — e.g. "all Engineering incident-response sessions," or "any session whose `outcome` is `decision_made`." Defined as a small set of policy rules (department, outcome, source_system match conditions), maintained by the security/admin team.
- **Employee choice governs everything else, additively only.** The employee can choose to link additional sessions beyond the mandatory floor; they cannot exempt a session that policy already mandates.
- **Mechanically, this reuses the pipeline we already have**: a session only becomes a Silver/Gold record when `record_insight` is called.
  - Admin-mandated categories → `record_insight` fires automatically at session end (employee is notified why, for transparency — not a silent capture).
  - Everything else → the employee (or their agent, with confirmation) calling `record_insight` **is** the opt-in. No call, no shared record. The session can still exist locally for the employee's own reference/handoff use — it just never crosses into Bronze.
- Every resulting record carries `consent_basis` (`admin_mandated` | `user_opted_in`) and `consent_actor` (which policy rule, or which employee) — see `data-passport-schema.md` §A — so the audit trail shows not just what was captured but why it was allowed to be.

This is the same admin-floor/employee-ceiling shape used for the Egress Gate's destination and category selection (`data-passport-security-egress.md` § Policy configuration model) — one consistent pattern across both gates rather than a different consent mechanism per checkpoint.

## 4. Serving layer — how agents and teams actually use it

An **MCP server** sits on top of Gold and exposes tools any connected AI agent can call:

- `search_knowledge(query)` — semantic + keyword search across all teams' curated knowledge.
- `record_insight(content, team, tags)` — write a new entry (goes through the Gate before landing in Silver/Gold).
- `announce_task(agent_id, task, status)` — an agent broadcasts what it's currently working on, into the activity ledger.
- `get_agent_activity(team | project)` — see what any agent, anywhere in the org, is working on right now.
- `handoff(session_id)` — pick up the context/state another agent session left off with.

A lightweight web dashboard reads the same Gold tables to visualize: live agent activity feed, knowledge search UI, and the redaction audit log (the "what didn't cross the border" view) — this last one is the strongest visual proof of the "Data Passport" concept for judges.

## 5. End-to-end flow

```
Team / AI Agent
      │  (raw capture: conversation, doc, decision, code note)
      ▼
 BRONZE  (object storage / folders — raw, unfiltered, still contains PII)
      │
      ▼
 THE GATE  (PII/secret detection → redact → tag provenance → audit log)
      │
      ├──► quarantined (failed/flagged, held for review)
      │
      ▼
 SILVER  (Postgres — clean, structured, provenance-tagged knowledge records)
      │
      ▼
 GOLD  (Postgres + pgvector — embedded, indexed, aggregated views + agent activity ledger)
      │
      ▼
 MCP SERVER + DASHBOARD  (search_knowledge, record_insight, announce_task, get_agent_activity, handoff)
      │
      ▼
Any team / any AI agent, anywhere in the org, anytime
```

## 6. Why this is a lightweight lakehouse, not a full one

We deliberately skip:
- Iceberg/Delta table format (ACID, time-travel, schema evolution at the storage layer)
- Spark/Trino distributed query engines

Because with a 4-person team on a hackathon clock, that infrastructure is pure setup risk with no demo payoff. A folder/MinIO Bronze layer + a Postgres Silver/Gold layer preserves the medallion story (raw → governed → served) and the passport-control narrative, while being buildable and demo-stable in the time available.

## 7. Suggested team split (4 people)

1. **Bronze + Gate (ingestion & redaction)** — build the raw capture format, PII/secret detection rules, redaction logic, audit logging.
2. **Silver + Gold (data model & search)** — Postgres schema, pgvector embeddings, dedup logic, aggregation views.
3. **MCP server** — expose the tools (`search_knowledge`, `record_insight`, `announce_task`, `get_agent_activity`, `handoff`) so any connected AI agent can use the passport.
4. **Dashboard / demo UI** — knowledge search view, live agent activity feed, and the redaction audit log view (the visual "proof" of the theme).

## 8. What to say to judges, in one breath

"We built the passport control checkpoint directly into our data architecture. Raw knowledge lands freely in Bronze. Nothing reaches the layer that teams and AI agents actually search and build on — Silver and Gold — without clearing the Gate, where PII and credentials get caught and logged. The result: knowledge travels freely across teams and AI agents, and the things that shouldn't travel, don't."

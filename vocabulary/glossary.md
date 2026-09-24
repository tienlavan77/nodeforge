# Vocabulary Glossary — NodeForge

Maps business terminology (how tickets/users phrase things) to standardized code terminology (function/module/variable names that should be used in the codebase). Purpose: narrow the semantic gap between tickets and code so `select_code_graph_candidates` (semantic search) finds the right file more reliably.

## Usage convention

- When naming a new function/module/variable: check the table below first. If the business concept already has a mapping, use the standardized code term.
- When writing a new ticket: if a business term below is used, optionally add it to `vocabulary_hints` in the ticket JSON so the coding agent can look it up easily.
- This file grows over time, driven by real miss cases found through `eval:retrieval` — it is not meant to be exhaustive from day one.
- New mapping suggestions (detected automatically by a Node + LLM pipeline) are written to a separate `glossary-suggestions.md`, pending human review before being merged here. Agents must not edit this file directly.

## Mapping table

| Business term | Standard code term | Notes | Source |
|---|---|---|---|
| Regenerate (response) | `retry`, `regen` | Do not use "recreate", "redo" in new function names | Miss case `1789476103218` |
| English / response language | `locale`, `i18n` | Do not use "language" in new function names | Miss case `1789476103218` |
| Chat (UI framework) | `conversation` | Ticket says "chat", code uses "conversation" (conversation-state-store); use "conversation" in new names | Miss case `1789356670440`, miner conf 0.95 |
| Architecture Manager (agent) | `architecture-manager` | Kebab-case agent id used in UI + adapter; do not use "architecture_manager" for new agent ids | Miss case `1789356670440`, miner conf 0.88 |
| Legacy Agent ID | `agentId` | Code field is `agentId`/`agent_id`; do not invent "legacyId" in new code | Miss case `1789356670440`, miner conf 0.90 |

## Update history

- 2026-09-20: Initialized file; first two rows from miss case `1789476103218` ("Regenerate English"), found via retrieval eval baseline.
- 2026-09-22: Merged 3 miner suggestions from miss case `1789356670440` (Chat->conversation, Architecture Manager->architecture-manager, Legacy Agent ID->agentId) after human approval; smoke batch 8 tickets, summary fix in `conversation-state-store.js`.
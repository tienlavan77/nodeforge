<!-- Records the approved O5 compatibility and memory-dependency alignment without granting production acceptance. -->
# Shared-agent project attribution

Ticket: `TICKET-NF-MPA-AGENT-SCOPE-05`.
Production status: **BLOCKED / NOT ACCEPTED FOR PRODUCTION** until required
canary, terminal receipt, and release authority evidence exist. Implementation
checks do not replace independent review or any lifecycle transport/thin-CLI gate.

## Retained Architecture Manager contract

The resolved Architecture Manager answer retained in the resumed ticket supplies
the compatibility contract and dependency alignment before implementation:

- Architecture basis: `PLAN-PROJECT-NODEFORGE-bd95299a-b504-423d-bfb9-57aac8cac8b4`,
  revision 1, SHA-256
  `5f48b8929371316d229ceb8b9f36b801ee721cce44dd8c9ff80017bfdfd31ecf`.
- Authority passage:
  `adb4b6045ad4d4fdced8e930902263c76251a70b2713030e86a9e150c670c652`.
- Retained handoff evidence SHA-256:
  `9828168723e6e68511a18ace7ffb219be6baf4b902e51bb002c7479561ee4b36`.

Occupancy adds nullable `project_id TEXT` with an additive SQLite migration.
Existing rows retain NULL attribution, identifiers, timestamps, and ownership.
There is no inferred startup-project backfill or destructive migration. Global
active-agent exclusivity and active task/role uniqueness remain unchanged.
New claims accept explicit project attribution or an explicitly configured
store default. Retry and release reject conflicting non-NULL project ownership.
Project-filtered lookup never returns a different project's claim; unfiltered
and explicit NULL lookup retain legacy recovery access.

Recovery skips attributed claims belonging to another configured project.
Legacy terminal-state and unresolved-launch recovery semantics remain intact.
Status events and notification-failure logs use persisted claim attribution;
the approved startup fallback for legacy publication does not mutate the row,
and status payloads retain explicit NULL attribution. Recovery diagnostics retain
NULL rather than inventing ownership.

## Conversation-memory dependency alignment

Owner Q1 makes `project_id` the sole isolation boundary. Architecture Manager
explicitly aligns the separate planned conversation-memory dependency to that
boundary and defers its runtime to the dedicated `NF-MEM-*` track. This ticket
neither implements nor rewrites `workflows/plan-conversation-memory.md` or
`ui/nextjs/lib/memory-projection.js`. It introduces no `workspace_id` isolation,
ACL, conversation-memory runtime, or cross-project plan support.

O5 covers existing `history-store.js`, `project-memory-store.js`, and
`memory-retriever.js` only. Their project filters are exercised with actual
occupancy status events and independent project facts. The focused integration
suite also exercises concurrent claims, release/reclaim, restart, notification
failure logs, archive retrieval, and legacy nullable-column compatibility.

Lifecycle foundation sequencing remains independent; combined transport and
thin-CLI acceptance is neither split away nor waived by this ticket.

<!-- Audits SL, Sprint Plan and ticket authority so legacy roadmap projections cannot authorize Registry scope. -->
# Registry ticket entrypoint cutover

## Scope

Owner request: audit SL, Sprint Plan and ticket paths still using roadmap authority.
This audit concerns repository implementation, not a verified runtime inventory.
The actual PLAN/TICKET-44DB0ADE receipt and deployed process were not inspected.

## Entry point inventory

| Entry point | Registry behavior | Source |
| --- | --- | --- |
| Sprint list/detail/create/replan/archive | Existing Registry CRUD; legacy list is used only to detect pending migration | backend/src/transport/http/forge-v1-sprint-crud-routes.js |
| Sprint SL draft / ingestion | Existing immutable draft and Registry binding; roadmap persistence only without Registry | backend/src/application/sprint-orchestration-service.js |
| Approved Markdown handoff | Exact approval and immutable child binding; no automatic RUN | backend/src/application/plan-handoff-service.js |
| Ticket View / graph | Immutable Registry spec, no stale fallback | backend/src/application/project-dashboard-service.js |
| Ticket RUN intake | Exact approved Registry spec and execution-fenced dependencies | backend/src/application/sprint-leader-intake-service.js |
| Review-only dispatch | Uses Registry intake rather than roadmap ticket lookup | backend/scripts/start-control-api.mjs |
| Builder context | Registry lookup, exact approval, current scheduling version; supports TICKET IDs | backend/scripts/control-api-builder-context.mjs |
| Ticket list | Current immutable Registry specs | backend/src/application/ticket-crud-service.js |
| Ticket add/edit/regenerate | Legacy mutation disabled with TICKET_REPLAN_REQUIRED; use a new Sprint Plan revision and approval | backend/src/application/ticket-crud-service.js |
| Ticket delete | Existing immutable revision replacement | backend/src/application/registry-ticket-deletion.js |
| Human Review evidence | Resolves current Registry ticket | backend/src/application/ticket-human-review-service.js |
| Human Review approval | Legacy unfenced completion disabled with HUMAN_REVIEW_REGISTRY_REQUIRED | backend/src/application/ticket-human-review-service.js |
| Guarded execution terminal events | Durable Ticket Status only; do not write roadmap | backend/src/modules/supervisor/terminal-bridge.js |
| Old HTTP Sprint/ticket aliases | Converge to canonical Forge router when configured | backend/src/transport/http/server.js |

## Deliberate compatibility paths

Standalone deployments without Registry retain legacy services and projections.
Roadmap reads for migration diagnostics are not execution authority. Immutable
approved scope must not be reconstructed from a mutable roadmap snapshot.
No runtime ticket data is deleted, migrated or automatically executed here.

## Remaining functional limitations

- Direct ticket add/edit/regenerate is not converted into automatic plan revisions.
  The Registry path rejects these legacy writes explicitly; use Sprint replanning.
- Registry owner completion requires an execution-fenced decision and integration
  recovery contract. The old Human Review implementation is not that contract;
  it is disabled rather than allowed to mark a different execution complete.
- Review-only dispatch still uses existing downstream checkpoint/evidence gates.
- No claim of browser visual smoke, deployed restart, remote push or runtime
  remediation follows from unit/integration checks.

<!-- Reports Registry-backed Sprint CRUD implementation, compatibility boundaries and the remaining focused verification gate. -->
# Sprint CRUD authority alignment

## Implemented

Public `/forge/v1/sprints` CRUD now routes through a dedicated Sprint CRUD adapter when Sprint Registry is configured. Legacy CRUD is used only when no Registry is configured.

- POST validates canonical Sprint/Ticket scope and complete human-plan review sections, creates an immutable Plan revision, and registers its scheduling basis. It does not approve or RUN the Sprint.
- GET list/detail uses Registry consistently. Unregistered legacy scope still raises migration-required diagnostics; a missing/archived Registry Sprint no longer falls back to legacy detail.
- PUT requires `expected_version`, validates the new scope, creates a new immutable revision and binds it using scheduling-version checks. Prior decisions are retained but do not approve the new revision. Sprint dependency changes are explicitly rejected by this scope-update endpoint; scheduling changes are not silently inferred.
- DELETE requires `expected_version` and archives the Sprint from active scheduling/list/dashboard visibility. Plan revisions, decisions, scheduling record, legacy Roadmap and Ticket histories remain retained. This is not physical record deletion or legacy-store retirement.
- Additive schema migration 19 creates `sprint_registry_archives`. Sprint IDs and historical positions stay reserved.
- Archive rejects running/completed Sprints, active dependents and unresolved Ticket execution/launch ownership. Archive checks and tombstone insertion are serialized in a database transaction. A new Ticket execution checks the archive tombstone at its transactional write.
- Dependency registration rechecks dependency existence/order inside its insertion transaction so it cannot insert a new dependency on an already archived Sprint.
- Registry detail/dashboard expose scheduling version. The UI client sends expected version for PUT/DELETE; fallback detail lookup supports callers lacking a captured version.
- Coding Delete confirmation describes retained Registry history, displays the archive result and refreshes the dashboard after success.
- CRUD routes were extracted from the existing router, bringing that file below the 250-line limit.

## Source and test files

- `backend/src/application/registry-sprint-crud-service.js` — new immutable scope creation/replan service.
- `backend/src/transport/http/forge-v1-sprint-crud-routes.js` — new public CRUD route adapter.
- `backend/src/transport/http/forge-v1-router.js` — delegates Sprint CRUD.
- `backend/src/modules/governance/sprint-registry.js` — archive, active/history inventory and transactional mutation gates.
- `backend/src/modules/projects/ticket-status-store.js` — tombstone gate at execution claim write.
- `backend/src/infrastructure/sqlite/sprint-registry-migration.js`, `index-migrations.js` — additive archive schema.
- `backend/src/application/registry-dashboard.js` — scheduling version and retained-archive inventory awareness. Existing unrelated ticket-deletion changes in this file were preserved.
- `ui/nextjs/lib/node-client.js`, `components/sprint-plan-panels.jsx` — versioned mutations and refreshed archive UX.
- `backend/tests/integration/registry-sprint-crud.test.js` — actual SQLite/immutable files/router and UI client over HTTP, stale version/project/scope/dependency checks, approval isolation, retained execution and archive-before-claim tests.

## Verification — FAILED; final repair not rerun

```text
node --test backend/tests/integration/registry-sprint-crud.test.js backend/tests/integration/coding-registry-dashboard.test.js backend/tests/unit/forge-v1-sprint-registry-list.test.js backend/tests/unit/http-api.test.js backend/tests/unit/sprint-registry-concurrency.test.js backend/tests/unit/ticket-execution-fencing.test.js ui/nextjs/tests/sprint-plan-panels.test.js ui/nextjs/tests/node-client-url.test.js
```

Run: `VERIFY-RUN-c0ea0074-7749-40cc-b96b-08fc3ea0c67e`.
Evaluated: `2026-10-09T07:18:21.845Z`.
Result: FAILED, exit 1, ready_for_review false.
Returned failure: `replan same Ticket ID cannot reuse old done evidence in RUN, DAG or dashboard` in `backend/tests/unit/ticket-execution-fencing.test.js`. The initial gate treated every retained execution ID as unresolved, including done evidence with no launch claim.

Repaired the gate to allow done Ticket evidence without retained launch claim; active/non-done ownership and every retained launch claim remain blockers. This preserves the existing replan compatibility test rather than rewriting its assertion.
Current repaired Registry SHA-256: `b3281cb5df057958ae3551cbf53f7e1e516bb691c863850b440d83f3e384a6ef`.
No second check was executed because this turn permits one run_check call. Final repair has NOT been verified. No PASS, test totals, browser validation or independent Reviewer verdict is claimed.

## Handoff and limits

- Exact-version PUT and query `expected_version` on DELETE are intentional API preconditions; external consumers must send a currently observed version. Missing/stale values yield reconciliation conflict.
- Legacy Sprint payloads without complete `human_plan` need explicit scope completion or the separate migration flow; CRUD does not fabricate approval content.
- Historical failed/unknown execution ownership may block mutation until reconciled. This is a safety gate, not automatic availability recovery.
- Immutable revisions created before a failed Registry bind/register remain retained with recovery identity on the application error. No automatic rollback/delete or full response-loss idempotency is claimed.
- The final focused rerun and independent review remain required before deployment. Schema 19 must be applied through normal startup/schema upgrade before archive-enabled code serves requests. No production schema/data migration, restart, HTTP request to the reported LAN deployment or rollout was executed here.
- Prior pending migration changes were not repaired or accepted by this task. No commit/push while the focused verification gate remains failed. Internal workflows reports remain local, not force-added to Git.

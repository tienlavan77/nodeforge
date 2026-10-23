<!-- Current implementation report for the Sprint Registry cutover, separating verified changes from remaining acceptance work. -->
# Sprint Registry Cutover — Current Implementation Report

Date: 2026-10-08

## Status

**Partial implementation; full cutover is not accepted.** The Registry read path and a safe migration diagnostic contract are implemented and covered by focused tests. Registry migration, all writers, dashboard/handoff convergence, and operational acceptance remain open.

## Latest follow-up — execution recovery 0h (2026-10-09)

Read audit 0h and the new execution-recovery plan in full. Implemented dependency expectation propagation from production DAG through shared RUN and approved dispatch into claim/history and queue payload, with original-plan/execution checks during integration preparation and before enqueue/inline launch. This is persisted intent plus guards, not atomic admission/recovery.

**Latest focused fixture check PASS; full execution recovery remains partial.** Repaired the test fixture with real governed-tool Registry and runtime governance factories, preserving existing dependency assertions and adding fake-provider MCP server/allowlist assertions. `node --test backend/tests/unit/ticket-dependency-submission.test.js` returned passed, exit **0**, ready_for_review **true**, run `VERIFY-RUN-156a73d0-ef09-4d62-ad6d-aa4c0749437d`, evaluated `2026-10-09T00:57:21.270Z`; fixture SHA `d27313d7f2cca8a0ce0deb9aaf0344dcbd47e7d5c94d14d3f1734874195642d1`. No production gate/source edits in this fixture follow-up. Earlier eight-file runs `VERIFY-RUN-4d1e8627-90c7-4604-94dc-1e282c0e398d` and `VERIFY-RUN-948929d7-5921-409a-ab8d-9b34c0605685` remain historical failures and were not rerun after the fixture edit. R1–R6/full O1–O7 are not accepted; independent review, admission/recovery and rollout gates remain open. Current Git outcome is in the detailed report.

Full command, failed/corrected source identities, eight scenario registrations, queued-job recovery risk and remaining decisions: `workflows/report-sprint-registry-cutover-execution-recovery-implementation.md`. Prior PASS results below do not verify this batch.

## Latest follow-up — dependency revalidation (2026-10-09)

Read the requested current audit and 0d in full, plus the latest linked 0g. Implemented post-wait dependency plan/execution/lifecycle checks and a final synchronous scheduling-version fence before dependent Ticket dispatch. Same-plan lifecycle completion remains reusable; rebind/block, replacement attempt, foreign Project and scheduling ABA during later dependency resolution fail closed.

Details, source identities, six new scenario registrations, remaining boundaries and Git outcome: `workflows/report-sprint-registry-cutover-dependency-revalidation.md`.

Focused command: `node --test backend/tests/unit/sprint-dependency-revalidation.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/sprint-dag.test.js`. Forge returned **passed**, exit **0**, run `VERIFY-RUN-0c539eef-2a42-4d30-8def-a6e8529c3565`, evaluated `2026-10-09T00:10:05.806Z`. Independent Reviewer pending; no browser/full-suite or crash/migration/restore witness. This guard is not atomic queue admission and does not close the O1–O7 verdict.

## Implemented

### Registry-first reads

- `GET /forge/v1/sprints/:id` reads the Sprint Registry first and uses the legacy Sprint-plan store only as a compatibility fallback.
- `GET /forge/v1/sprints` reads Registry details first.
- When both stores contain current Sprints and a legacy-only ID exists, the list path stops with `409 SPRINT_REGISTRY_MIGRATION_REQUIRED` instead of silently hiding that legacy Sprint.
- Registry detail preserves scope identities in public `ticket_ids` and exposes available immutable specs in public `tickets` (the internal source is `ticket_specs`). It does not fabricate ticket detail or infer approval.
- C3 remediation: ticket lookup skips only records whose entire plan binding is null. Partial bindings, mismatched project/Sprint/path/hash, missing files and tampered bytes fail closed; detail reads use the same validation.

### Migration diagnostic contract

- The mixed-inventory conflict is explicitly `retryable: false` and `scope: "scoped"`.
- Backend canonical errors retain a bounded `identifiers` list. Values must be safe identifier strings; invalid entries are discarded.
- UI `normalizeUiError` preserves the same safe `identifiers` field without parsing a message.
- `GlobalToast` now presents the affected Sprint IDs for `SPRINT_REGISTRY_MIGRATION_REQUIRED`; it gives the operator a bounded reconciliation target and does not offer a retry for this non-retryable conflict.

### UI data clarity

- `SprintTicketScope` displays neutral scope counts and a missing-immutable-detail status. Draft, approved, ready, empty, unbound and legacy projections do not get a fabricated approval label.
- The previous source-string test was replaced by React HTML render assertions for the extracted component. This is not a browser or full modal interaction witness.
- GlobalToast guidance is implemented/static confirmed. Legacy PendingPlanApproval/PlanReviewModal diagnostic loss was found statically, but active reachability was not established. The actual `/coding` dashboard loader/state path and its focused HTTP/client/HTML witness are covered in the latest Coding remediation report below; that is not a full browser or Sprint-list consumer proof.

## Verification

Historical focused regression checks passed (Coder-reported; not an independent acceptance verdict). Each latest batch below records its own command/run; earlier checks are not implicitly rerun:

```text
node --test backend/tests/unit/error-contract.test.js backend/tests/unit/forge-v1-sprint-registry-list.test.js ui/nextjs/tests/error-normalizer.test.js
node --test backend/tests/integration/error-envelope-transport.test.js
```

The integration witness starts a real HTTP listener and asserts that the Registry/legacy mixed-inventory condition returns the canonical `409` body, including safe `identifiers`, `retryable: false`, and `scope: "scoped"`.

## Open acceptance work

| Area | Remaining work |
| --- | --- |
| HTTP witness | Implemented with focused pass; independent review and actual consumer DOM witness pending. |
| Inventory | Reconcile all legacy versions/revisions, including history-only records and same-ID content conflicts. |
| Writers | Move Sprint create/update/delete and ticket-related mutation paths to the Registry. |
| Consumers | Remove Dashboard/Handoff Roadmap unions, metadata overrides, and wrapper reads. |
| UI recovery | Partial: `GlobalToast` presents the safe affected Sprint IDs; no automated reconciliation action is available. |
| Operations | Produce migration manifest, backup/restore, resume/rollback, restart/RUN parity, and reviewer acceptance evidence. |
| Cleanup | Retire legacy stores/schemas only after the prior items are accepted. |

## Audit remediation verification — 2026-10-08

Baseline: `report-sprint-registry-cutover-current-audit.md`, latest follow-up 0a, SHA-256 `3ba8751ea7e8e08d27b93c7b75d408635e95f63ec83399486989e84399b9d239`.

```text
node --test backend/tests/unit/sprint-registry-ticket-lookup.test.js backend/tests/integration/human-plan-workflow.test.js ui/nextjs/tests/sprint-plan-panels.test.js
```

Forge returned **passed**, exit code **0**, run `VERIFY-RUN-afe6c2ec-f1a1-4f1a-b160-1eca06cfbc36`, evaluated `2026-10-08T17:09:52.050Z`. No full-suite, build, lint or browser run. Forge does not return TAP counts or raw output hashes here; these are not claimed.

- New lookup tests use disposable SQLite and the actual immutable file store: empty, unbound-before-bound, missing ticket, partial binding, mismatched path/hash, foreign-project reference, project isolation, missing file and tampered file.
- Existing human-plan workflow regression passed, including approval/replan execution gates.
- Seven rendered scope cases passed: three statuses with partial detail and full/empty/unbound/legacy counts. The approved input remains neutrally labelled; no new approval authority or projection was introduced.

Source identities (individual reads/edits, not an atomic repository snapshot):

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-registry.js` | `2f794586f76ed53789ea9940f701ab97b2d60fff2f2f855a9a852759af3d90cd` |
| `backend/tests/unit/sprint-registry-ticket-lookup.test.js` | `fa9c51d9899b9f990d146c38d77d1ce654b45917f626b196d256d118f24315e7` |
| `ui/nextjs/components/sprint-ticket-scope.js` | `8ea45909e2ebdff597cf4055b4d524079330661b6c021d1bab9001a471a9042d` |
| `ui/nextjs/components/sprint-plan-panels.jsx` | `5bb502e78ea5f90c50afcc25fbd397bd1de7fe5d30028ef7f30efc21eda2139a` |
| `ui/nextjs/tests/sprint-plan-panels.test.js` | `7edd42bd640d2334de90097fdc3312cf0c2a947f45c8016bdc969769646b2575` |

## Outcome coverage and remaining evidence

| Outcome | Status and next responsible party |
| --- | --- |
| O1 | Open: active Roadmap contracts/schema/UI convergence; implementation owner. |
| O2 | Partial: C3 lookup repaired; writer authority and all-or-nothing mutation remain; implementation owner. |
| O3 | Partial: scope component HTML and HTTP error witness; actual consumer structured diagnostic/DOM recovery remains; implementation owner and Reviewer. |
| O4 | Open: handoff authority, durable receipt reload and duplicate-safe continuation; implementation owner. |
| O5 | Partial: false approval labels removed; Registry bind/status version CAS implemented with focused race/restart tests (latest section below). Cross-store atomicity, dispatch attempt fencing and durable replay remain; implementation owner and Reviewer. |
| O6 | Open: full authorized inventory/revision/link reconciliation, backup/restore, conflicts/resume and rollback preserving new writes; rollout owner. |
| O7 | Blocked on O1–O6 acceptance and human retention/cleanup decision; no stores/schema retired. |

Consumer guidance must survive the actual listSprints callers, handle missing/bounded IDs, show requestId, avoid automatic retry, and never repost committed approval/handoff on a read conflict. Those paths have not been changed or behaviourally verified in this remediation.

## Latest remediation — Registry mutation CAS, 2026-10-08

Baseline: audit follow-up **0b**, SHA-256 `7ce84d511f03d9b177779aef52fac987ebc4995f8cad17aae45a9c2b54ac2d45`.

### Implemented

- Additive SQLite migration 18 introduces `sprint_registry.version`, initially 0; no current rows, legacy stores or immutable plan files are dropped by this migration.
- `bindPlan` and `setStatus` validate a scheduling snapshot before awaiting immutable plan checks and update only `WHERE sprint_id/project_id/version` still match. A successful write increments version atomically.
- Stale writes produce `409 SPRINT_REGISTRY_CONFLICT`, non-retryable/scoped, with the affected Sprint identifier. This also fences same-basis, same-timestamp intervening writes (ABA).
- Optional `expectedVersion` is accepted by the Registry and optional `expected_version` is forwarded by the Registry plan/status HTTP routes. Existing callers without this precondition still get in-operation CAS; the UI client does not yet submit its displayed version.
- Rebinding also checks the immutable plan's Project/Sprint identity. Existing lifecycle/approval gates remain in place.
- Historical migrations 11/12 were moved without changing their statement order or purpose to `sprint-registry-migration.js`, keeping the edited index migration file below the 250-line limit. This extraction does not rerun already recorded migrations.

### Consumer reachability inventory (static, not browser proof)

| Path | Source finding and remaining work |
| --- | --- |
| `/coding` → CodingWorkspaceMonitor → SprintPlanDashboard | Loads `getProjectDashboard`, not listSprints. Load failure logs and clears the dashboard; scoped recovery is not implemented here. |
| `/code` | Redirects to `/coding`; it does not mount NodeForgeApp. |
| PendingPlanApproval → PlanReviewModal → listSprints | No current page import was found by targeted search; treat reachability as unconfirmed, not active or obsolete by assumption. Structured-error loss and committed-handoff read recovery remain open if reintroduced/mounted. |
| NodeForgeApp → NodeForgeShell → SprintPlanDashboard | Legacy shell source also loads getProjectDashboard; current page reachability has not been proven. |

No disconnected approval component was patched solely to close a finding. Active UI diagnostic coverage still needs route/client/DOM evidence; GlobalToast alone does not establish it.

### Verification and evidence

```text
node --test backend/tests/unit/sprint-registry-concurrency.test.js backend/tests/unit/sprint-registry-version-migration.test.js backend/tests/unit/sprint-registry-ticket-lookup.test.js backend/tests/integration/human-plan-workflow.test.js backend/tests/unit/markdown-plan-approval.test.js
```

Forge returned **passed**, exit **0**, run `VERIFY-RUN-56ecf02f-fdfe-4c57-aa43-0472dd4a76fa`, evaluated `2026-10-08T17:27:18.648Z`. This batch did not rerun the older HTTP-error/UI render checks above. Node's SQLite and actual immutable stores were used; exact Node version, raw TAP counts, output hashes and independent Reviewer verdict are unavailable from the tool result.

Witnesses cover delayed readiness versus newer unapproved rebind, rebind versus running on a second SQLite connection, completion versus blocked, same-clock ABA, concurrent binds with one winner, route expected-version forwarding/project isolation, and version-17 data preservation/restart/stale-version rejection. These are deterministic interleavings, not production load/crash acceptance.

| Source | SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-registry.js` | `399247b6a68a2994dbf7922ab3e9626d002da6164be26a26b7763da7c530d020` |
| `backend/src/infrastructure/sqlite/index-migrations.js` | `ab2765fd3ee0879e10660c75ae7c9862617a68d065719ee2ce73eb5b67752ebc` |
| `backend/src/infrastructure/sqlite/sprint-registry-migration.js` | `099ca520fdf722e5007b46a453d77bb011276cdaef9e50550a4330f695bb3568` |
| `backend/src/transport/http/forge-v1-plan-routes.js` | `499d21696564f56d4eeefb296bce683cccd02b51e7d4d2b1b8c276d99b61445e` |
| `backend/tests/unit/sprint-registry-concurrency.test.js` | `97ee929247993894f06180f8a79a94dcfb65bc721d27dd883462174fcdcfd69b` |
| `backend/tests/unit/sprint-registry-version-migration.test.js` | `4dfe29de72c8680ea1a32587cd287372670f5425f8a9eda3375fc231356c92bf` |

These are individual edit identities, not an atomic run snapshot. The Registry's final hash includes a summary-comment-only addition after the test run. Git inspection found 18 dirty tracked/untracked paths, including earlier staged remediation; this batch changed the six code/test files above plus this ignored report. No unrelated edits were reverted.

**Remaining:** all-source inventory/readiness and migration reconciliation, authoritative writers/dashboard/handoff convergence, client-displayed expected-version propagation, cross-store approval/file mutation atomicity, dispatch attempt identity/fencing, committed-handoff reload without duplicate mutation, durable crash/replay and active consumer DOM recovery. Registry row CAS alone does not close full O2/O4/O5/O6 or authorize O7 cleanup. Production migration/rollout and destructive cleanup were not performed.

## Latest remediation — observed draft basis and readiness, 2026-10-08

Baseline: audit follow-up **0c**, SHA-256 `267edf8a093ebd8d58fae9200761418fc185574e64ccb8f233ba084eced31cfa`.

- Draft persistence now captures the Registry record before the first approval-validation await and passes that original version into bind. It does not refresh its expectation or retry a stale write.
- Exact-parent recovery reuses an existing immutable revision, validates the observed scheduling version, and avoids resetting status/version when that exact revision is already bound. Previously unbound or differently bound snapshots use guarded bind rather than silently returning an unbound plan.
- On scheduling conflict/registration race/running-basis conflict, immutable revisions and derived approvals are retained. The thrown error includes service-level `recovery` identity/disposition for reconciliation (`retained_immutable_revision`), with no evidence deletion or automatic overwrite. This metadata is not a new public HTTP envelope field or a durable recovery job/receipt; those remain open.
- `assertReady` accepts an optional expected version, verifies exact Project/Sprint/path/hash and rechecks the scheduling version after immutable approval validation. Block/rebind/same-basis ABA during validation cannot return a stale successful readiness result.

```text
node --test backend/tests/unit/sprint-plan-draft-concurrency.test.js backend/tests/unit/sprint-registry-concurrency.test.js backend/tests/unit/markdown-plan-approval.test.js backend/tests/integration/human-plan-workflow.test.js
```

Forge returned **passed**, exit **0**, run `VERIFY-RUN-8dcc6083-113c-4996-a405-ba8683feb7ac`, evaluated `2026-10-08T17:40:21.463Z`. This batch uses real SQLite/immutable stores with controlled pauses. No browser, UI, migration, load or crash tests were run in this batch; historical checks above are not claimed as rerun. TAP counts/raw output hashes/exact Node version and independent Reviewer verification are unavailable from the tool result.

Witnesses: two drafting workflows interleave after immutable creation and before bind; the stale loser preserves the winner and earlier revision. Approved-parent interleaving preserves derived approval, and exact-parent continuation leaves ready scheduling unchanged. Initial registration race retains both indexed revisions. Readiness fails after block, new-revision rebind or same-basis rebind/readiness ABA. Existing approval/replan gates regressions also passed.

| Tested source | SHA-256 |
| --- | --- |
| `backend/src/modules/governance/sprint-plan-draft-persistence.js` | `69e3272166df9bb973b36d83417ebff72e35e7b07a5b9276f88052fff667d30b` |
| `backend/src/modules/governance/sprint-registry.js` | `d5fa38056917ccd4a010b37faa3c24ced30885c4c34ce49f77523d21ed942a7a` |
| `backend/tests/unit/sprint-plan-draft-concurrency.test.js` | `87928af2c81eb8a23434266378916127b1b392abaf72ddbf81937f74b6f52b7c` |
| `backend/tests/unit/sprint-registry-concurrency.test.js` | `3dd60373d1e74499b6bc35fa8d6364297abeb0394245176847140510b28c52c0` |

These are individual file identities, not an atomic repository snapshot. No source code was edited after this verification; only this report was updated.

**Still open (O2/O4/O5):** caller intent before entering draft persistence is not automatically protected; other mutation callers must propagate their own observed version. Readiness recheck is not durable admission: checkpoint/clear awaits and dispatch/event handling still need exact basis plus attempt fencing, crash/replay and stale terminal-event witnesses. File/index/approval/bind/handoff are not made one atomic transaction by this patch; durable recovery/reconciliation remains necessary. The earlier v17 migration witness is synthetic (DROP COLUMN/remove marker on a disposable new database), not a original v17 artifact or migration crash/rollback proof. Active dashboard/consumer UI convergence (O3), full migration evidence (O6), and cleanup gates (O7) remain open. No production approval, RUN, migration or cleanup was performed.

## Latest remediation — follow-up 0d Sprint RUN basis, 2026-10-08

Read both audit documents in full: `report-sprint-registry-cutover-current-audit.md` (246 lines, SHA-256 `a1efde202d3c176d8ec450015f2e48f1a6b5f97d3d5b2bb2b5120260b39c48b2`) and `report-sprint-registry-cutover-follow-up-0d.md` (51 lines, SHA-256 `110466a5b260aacfbb4eb52869268666b15b7a5e26a0245839a759620b223e5e`). This section reports implementation evidence, not edits to Architecture conclusions or acceptance.

- Extracted production Sprint RUN into `createSprintRunDispatch`. It now reads executable tickets directly from the approved immutable Registry plan rather than `sprintPlans.getSprintById`. Membership, ticket Project/Sprint scope and DAG validation precede admission.
- The ready-to-running write supplies the originally observed version. The persisted running version and exact Project/Sprint/plan/revision/path/hash are captured as the execution basis. Parallel admission has one CAS winner; a durably running Sprint cannot be admitted again simply because the process restarted and an in-memory Set is empty. `runningSprints` was removed from production.
- Both completion and failure callbacks supply that same admitted version, never a freshly loaded expectation. A callback from an older execution cannot overwrite block/ready/new-RUN scheduling, and logs a scoped conflict for reconciliation. Callback failures do not silently retry or mark the newer execution failed.
- The DAG carries the basis through each ticket dispatch. Ticket RUN preserves the first observed version across checkpoint/resume/clear awaits. Production **already had a second readiness check**; it was not missing. That check now requires and compares the caller's original exact basis rather than accepting whichever binding happens to be current, and forwards `sprint_basis` in the supervisor submission payload. Missing/cross-project/forged basis is rejected before submission.
- Extracted the production submission boundary into `createApprovedTicketDispatch` so tests exercise the actual boundary function, not a source-string assertion. Existing resume fields, roles, request/correlation IDs and abort handling are preserved.

```text
node --test backend/tests/unit/sprint-run-basis.test.js backend/tests/unit/ticket-run-dispatch.test.js backend/tests/unit/sprint-dag.test.js backend/tests/unit/sprint-registry-concurrency.test.js backend/tests/integration/human-plan-workflow.test.js
```

Forge returned **passed**, exit **0**, run `VERIFY-RUN-fe3cf575-4ec1-4fda-ae2f-d3ac78f09550`, evaluated `2026-10-08T18:00:47.746Z`. The new test file defines nine behavioral cases: successful immutable-scope execution, parallel admission, paused readiness-to-RUN ABA, stale success, stale failure, reopened SQLite/Project isolation, checkpoint await followed by rebind, exact production submission payload/rejection, and actual DAG basis forwarding. Tests use real SQLite and real immutable owner approvals for Registry boundaries, with controlled DAG/submission doubles; no real agents or production RUN were invoked. Existing ticket resume/DAG/Registry/human-plan regressions are included in this one focused run. The reopening witness uses another SQLite connection and freshly constructed services, not a killed-process/recovery drill. UI/browser/build/lint/migration checks were not run. Tool output does not provide TAP totals, exact Node version or raw-output hashes; independent Reviewer verification remains pending.

| Source identity for this batch | SHA-256 |
| --- | --- |
| `backend/src/application/sprint-run-dispatch.js` | `f76a3b6beaa15b9caa2de9ebd61cb651609124c2ba06f97383d7a126f9b7158a` |
| `backend/src/application/approved-ticket-dispatch.js` | `01e67772c2555a4b4f2ecbf07f0436743ccc48ce4f40ae066879beb78bbfe29d` |
| `backend/src/application/ticket-run-dispatch.js` | `74b2f01666d52482e166eae2cc3d52faaab8806af56c194279618378eb159da2` |
| `backend/src/modules/supervisor/sprint-dag.js` | `9fb78b64e97c45c631bc382b9478077741b81c7f21818d73680283be26d7df1c` |
| `backend/scripts/start-control-api.mjs` | `769ecca9bb315a42456bf96aa4280546bdd39047d458ff2c4f79db223c28ab13` |
| `backend/tests/unit/sprint-run-basis.test.js` | `50d9c17ac4021fb350054a75f1c1ee6a1bd96ab648af33a4491345437feeb89d` |

These are individual file identities, not an atomic repository snapshot. This batch changed those six code/test files plus this report; the Forge verification session's broader `changed_paths` list includes earlier work and is not this batch's diff. No source edits followed verification.

### Remaining 0d acceptance work — not closed by this patch

1. **O2/O5 caller intent:** draft persistence only captures its entry snapshot; upstream writer/client observed-version propagation and inventory remain incomplete. Optional expected-version compatibility is unchanged; no stale-intent automatic reload/retry was added.
2. **O5 durable admission:** storing a basis in submitted payload and doing version checks does not atomically fence SQLite scheduling against asynchronous Supervisor queue admission. Block/rebind between the last check and durable submit, parallel Ticket RUN across processes, durable attempt IDs, crash/replay/dedup and checkpoint-clear/status mutation recovery remain open. The checkpoint-race test proves no submission against a newly loaded basis, not that prior clears/status writes were rolled back.
3. **O5 lifecycle/events:** this patch fences production Sprint start and callback writes using persisted Registry versions, but does not establish a durable run receipt/outbox or resumable orchestration. Ticket terminal events and DAG dependency listeners still need exact Ticket/revision/attempt identity and duplicate/out-of-order/replay fencing. A blocked orphan running record requires reconciliation rather than automatic redispatch.
4. **O2/O4/O5 recovery:** file/index/approval/bind/handoff/receipt/event boundaries are not one recoverable protocol yet. Earlier `error.recovery` is service-level retained-evidence metadata, not a durable receipt/job or public HTTP contract. Retained-but-unbound revision reconciliation and receipt reload without duplicate approval/handoff still need crash/failure injection.
5. **O1/O2/O3/O4 authority/UI:** Sprint RUN now uses immutable Registry ticket specs, but ticket intake/review/handoff/dashboard and legacy writers still need convergence. Active `/coding` dashboard structured diagnostic preservation, scoped rendered HTTP/client recovery with safe bounded IDs/requestId, Project isolation, unavailable-versus-empty distinction and non-retryable behavior remain unverified; inactive approval components are not substitutes.
6. **O6/O7 migration:** full per-version/source/link manifest, authorized conflict decisions, actual historical-v17 provenance, backup/restore/resume and rollback preserving new writes/events remain required. The prior synthetic fixture does not close these blockers. No store/schema retirement, legacy drop, migration, production approval or rollout was performed.

**Git evidence:** inspected `git_status` and `git_diff` before commit. Status showed 26 changed paths: 20 previously staged, three modified tracked paths and three new untracked files; the ignored report does not appear there. Existing earlier remediation was preserved. `commit_changes` returned `GIT_ADD_FAILED` because `workflows/` is ignored. No commit SHA was returned, so no push was attempted. No force-add or ignore-rule change was made. This Git-outcome note is a report-only update after verification/commit attempt.

**Verdict: partial O2/O5 remediation, not full cutover completion.** Architecture audit conclusions are preserved. O1–O7 acceptance needs the remaining evidence and independent Reviewer/human decisions.

## Latest remediation — active Coding Registry dashboard, 2026-10-08

Full coder evidence and remaining outcomes: `workflows/report-sprint-registry-cutover-coding-dashboard.md` (separate report to keep this file below 250 lines). Both requested audits were read in full, plus newly linked superseding follow-up 0e. Registry dashboard scope and active `/coding` structured diagnostic rendering are now implemented; actual HTTP/client/loader/React HTML witness passed in run `VERIFY-RUN-ccde9716-4b8a-468a-9324-4f249d567b5b`, exit 0, evaluated `2026-10-08T18:22:50.821Z`. This is partial O2/O3 remediation, not full authority convergence, browser verification, durable admission/recovery, migration/restore or O1–O7 acceptance. Current-ID guards do not constitute full inventory/cutover readiness. Historical claims above are superseded only where the latest report explicitly records a delta.

## Latest remediation — Ticket execution ownership and parity, 2026-10-08

Full coder evidence: `workflows/report-sprint-registry-cutover-ticket-execution.md`. Both requested audits and superseding 0f were read in full. Existing Ticket Status Store now persists execution ID/basis claims; production RUN/terminal/failure/DAG paths preserve and fence that identity. Stale done from another immutable revision is not reused by RUN/DAG or displayed as completion in the Registry dashboard. This is partial O2/O3/O5 remediation, **not atomic queue admission or complete crash/replay recovery**. Focused nine-file command passed, exit 0, run `VERIFY-RUN-939ccc1c-24c4-40ff-b1f3-a92ef9c9630c`, evaluated `2026-10-08T22:56:53.848Z`; independent Reviewer verdict remains pending. Latest report explicitly separates implemented deltas from remaining compatibility/producers, side-effect recovery, durable receipts, mounted UI and migration blockers. Earlier open findings are superseded only to that documented extent; no legacy cleanup or production RUN was performed.

## Scope note

This report records partial repository implementation and focused evidence, not a completed migration, production rollout or full O1–O7 acceptance. Independent Reviewer verdict and complete source-bound verification bundle remain pending. No new approval or RUN was performed. Forge denied the local Next.js guide under node_modules; this change uses plain React rendering and existing component integration, with no new Next.js-specific API.

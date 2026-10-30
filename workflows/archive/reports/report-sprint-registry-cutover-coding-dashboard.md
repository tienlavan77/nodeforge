<!-- Implementation evidence for the active Coding Registry dashboard and scoped diagnostics, separate from Architecture audit verdicts. -->
# Sprint Registry — Coding dashboard remediation

Date: 2026-10-08. **Verdict: partial O2/O3 remediation; full cutover O1–O7 is not accepted.**

## Audit baseline

Read the entire current audit (250 lines), the entire requested follow-up 0d (51 lines, SHA-256 `110466a5b260aacfbb4eb52869268666b15b7a5e26a0245839a759620b223e5e`), and its newly linked superseding follow-up 0e (53 lines, SHA-256 `f865424c95e9b75b6de60928e0112e424c99e72206cada7c53e26073d5516375`). The previous Sprint start/callback and pre-submit version propagation fixes remain implemented; they were not redone or treated as missing. Architecture conclusions were not edited.

## Implemented code

- Added `getRegistryDashboard` and wired it into the existing `createProjectDashboardService.getDashboard` whenever the production Registry detail interface exists. Registry Sprint metadata and immutable ticket specs are authoritative for this dashboard branch. Legacy Roadmap/ticket metadata provide current-ID reconciliation diagnostics, not ticket content overrides.
- Registry records are filtered by Project before any immutable detail reads. A foreign Project's malformed binding does not cause another Project's dashboard to leak its identifier or diagnostic.
- Legacy-only Sprint IDs now fail with canonical non-retryable scoped `SPRINT_REGISTRY_MIGRATION_REQUIRED`, even when Registry is empty. Same-ID legacy ticket edits no longer overwrite immutable ticket title/objective/scope. Extra persisted ticket IDs outside the bound immutable scope fail closed. Public dashboard retains its existing `roadmap.sprints` container for compatibility, with null legacy Roadmap ID/version in the Registry branch; these are not invented Roadmap authorities.
- No active mutation was introduced. Dashboard task progress still uses the existing Project-scoped Ticket Status Store, which is **not yet revision/attempt fenced**. The compatibility branch for callers without the full Registry interface and legacy ticket-detail/graph APIs remain unchanged.
- Added `createCodingDashboardLoader`, mounted by `/coding`: distinct loading/ready/error state; preserves normalized code/scope/retryable/identifiers/requestId; drops stale responses; rejects cross-Project responses; invalidates in-flight reads on unmount. After a non-retryable conflict, stream refreshes do not repeat the failed read automatically. Explicit page reload or a deliberate manual read can recover after operator reconciliation; no mutation replay is performed.
- Added `CodingSprintDashboardState`, mounted by `CodingWorkspaceMonitor`: unavailable differs from empty; error state suppresses Sprint controls, shows safe IDs (bounded subset, not full inventory), requestId and authorized reconciliation guidance. Non-retryable errors have no Retry button. Retryable outages may retry only the dashboard read. Workspace Agent panels remain visible and unchanged.
- Updated the existing Coding navigation wiring assertion for the extracted loader/state component. This source assertion is supplementary to the behavioral HTTP/client/loader/render cases.

## Verification

One focused check was run:

```text
node --test backend/tests/integration/coding-registry-dashboard.test.js backend/tests/unit/project-dashboard-service.test.js backend/tests/integration/error-envelope-transport.test.js ui/nextjs/tests/conversations-navigation.test.js ui/nextjs/tests/error-normalizer.test.js
```

Forge: **passed**, exit **0**, run `VERIFY-RUN-ccde9716-4b8a-468a-9324-4f249d567b5b`, evaluated `2026-10-08T18:22:50.821Z`. Tests are Coder-run evidence; independent Reviewer verdict remains pending. The tool does not expose exact Node version, TAP totals/skips or raw-output hashes; those fields are unavailable, not guessed.

Five new behavioral tests cover:

1. Real SQLite/immutable plan store dashboard scope survives same-ID legacy edits and rejects persisted extra tickets.
2. Actual Forge dashboard route/server listener → actual Node client/requestJson → loader mounted by Coding → React HTML state renderer: safe 25-ID bound, unsafe ID filtering, requestId, unavailable alert, no controls/Retry, no auto retry after conflict, Project isolation, and read continuation after resolving the current-ID conflict.
3. Empty Registry with legacy Sprint inventory fails closed; foreign Project and foreign corrupt binding do not leak data/errors.
4. Loading/empty/retryable outage/missing-safe-ID conflict render distinctly with recovery guidance.
5. Out-of-order reads do not overwrite newer state and foreign-Project response content is not exposed.

These tests use actual Registry/immutable storage and a local HTTP listener, with legacy inventory doubles. Rendering is React static HTML, not a mounted browser/Next page or interactive modal witness. The actual page imports/mounts the tested loader/gate; the existing navigation test checks that integration in source. No browser, visual/accessibility audit, production server request, real agent, approval/RUN, migration, crash/restore drill, lint/typecheck/build or full suite was performed.

UI rules require local Next.js guides. Forge denied reading `ui/nextjs/node_modules/next/dist/docs/01-app/03-api-reference/01-directives/use-client.mdx` with `FILE_ROLE_FORBIDDEN`. The patch uses plain React hooks/rendering and existing client/page integration, no new Next-specific API. This access limitation remains part of evidence, not an assertion that the guide was read.

## Source identities

Individual Forge edit identities, not an atomic repository/test snapshot. No source edits followed the check; only reports were updated.

| File | SHA-256 |
| --- | --- |
| `backend/src/application/registry-dashboard.js` | `477eb4e355e87eed097974d9a47d13f900095d5f5db11d82491034fd7c2436e6` |
| `backend/src/application/project-dashboard-service.js` | `da6e280a4e5601965319451ec49c702e6096e15dcfb1425937e740ac1bd384ed` |
| `ui/nextjs/lib/coding-dashboard-loader.js` | `56280678c8abf59a7c73ab65c68862f0bd5315b09d7bb8aed91db32ef31cc53f` |
| `ui/nextjs/components/coding-sprint-dashboard-state.js` | `32426f81335ace413bd916d33047d1b3c634f01cc857d778ce0d3825a482ed9d` |
| `ui/nextjs/app/coding/page.jsx` | `76633bd5a65db26c0293d4a4da3185c99addf966c8e9c09190c743da40b5c354` |
| `ui/nextjs/components/coding-workspace-monitor.jsx` | `c8ed8b6b7a02b4919424bfc70de3d614435e589c3640efee648fbd8f0573cca0` |
| `backend/tests/integration/coding-registry-dashboard.test.js` | `da5668c082e1fcdb3c5bcbffa0bcd6b790dabc5c6be3ae18710a63e30e276ff7` |
| `ui/nextjs/tests/conversations-navigation.test.js` | `2bd939c3ca7bf1f22672ad8876d8cdf4c6f307105b09fdcb09b8fb676680c1f4` |

This batch changed these eight code/test files and two reports. Forge verification's wider session changed_paths includes prior work and is not this batch's diff.

## Remaining acceptance work

- **O5:** pre-submit basis is not atomic durable queue admission. Durable attempt/receipt protocol, actual submit pause/rebind/block, parallel processes and killed-process restart/reconciliation remain open.
- **O5:** Ticket terminal events/DAG done reuse/dependencies remain ID/status-based, not exact Project/revision/hash/attempt evidence. Old event/done reuse, duplicate/out-of-order/reconnect witnesses and attempt-unscoped failure handling remain open.
- **O2/O5:** checkpoint/protocol/conversation clears and status writes still precede final admission. No recovery/rollback of these writes or stale-failure catch fencing was implemented in this batch.
- **O2/O4/O5:** upstream observed intent before draft entry, cross-store file/index/approval/bind/handoff receipt/event durable reconciliation and committed-receipt continuation remain open. Service `error.recovery` is not a durable job or receipt.
- **O1/O2/O3/O4:** Registry dashboard scope convergence is implemented in this branch, not all writers/intake/review/detail/graph/handoff convergence. Full per-version/source/link inventory, same-ID content/revision conflict detection and explicit approved readiness are not proved by current-ID guards. The UI guidance refers an authorized operator to that inventory; it does not provide a new full-inventory API or prove an operational recovery drill. Browser/interactions and independent active-consumer review remain pending. Legacy approval components were not patched solely to satisfy disconnected findings.
- **O6/O7:** historical upgrade provenance, authorized conflicts, backup/restore/crash/resume/rollback preserving writes/events, Reviewer evidence bundle and exact human rollout/retention decision remain blockers. No legacy schema/store was retired or dropped.

## Git handoff

Inspected Forge `git_status` and `git_diff` before commit. Status showed 34 changed paths: 26 already staged from prior remediation, four modified tracked files and four new untracked files for this batch; ignored reports were not included in status. Prior work was preserved. `commit_changes` returned `GIT_ADD_FAILED` because `workflows/` is ignored. No commit SHA was returned and no push was attempted. No force-add, ignore-rule change or destructive cleanup was performed. This report-only Git-result update followed verification and the commit attempt.

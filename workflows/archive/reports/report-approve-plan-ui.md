# Approve Plan UI — implementation and verification report

Date: 2026-10-10 (UTC)
Reference: `workflows/approve-plan-ui.md`
Status: corrected revision 2 follow-up passed the authorized eight-file focused recheck. Full acceptance remains open; historical failed runs are preserved below.

## Authorized final-snapshot focused recheck — 2026-10-10

Owner authorized one additional check. Executed exactly the eight-file command recorded in the latest audit follow-up below, without source/test edits in this turn.

- Result: PASS, exit 0; service `ready_for_review=true`.
- Run: `VERIFY-RUN-ad0a8df1-6782-4659-bdb4-ea04749030f3`.
- Evaluation timestamp: `2026-10-10T11:30:00.967Z`.
- Covers the corrected Markdown readback/storage-contract fixture, diagnostics fault injection and command regressions, handoff regressions, lifecycle projection/schema validation, shared UI event reducer/fan-out and Coding loader/source assertions.
- Source/test files were not changed after this check; only this report was updated.
- Raw output, individual test counts, Node version and an atomic source-bound manifest were not supplied. This is service-reported focused evidence, not independent acceptance. The service execution identifier is not a Git commit.
- SQLite reopen witness uses File Service/Registry-write doubles; it is not a killed-process or multi-process production witness. UI source/reducer tests are not browser/network/accessibility evidence.

Historical FAIL `VERIFY-RUN-d57a8789-0d33-4d51-a974-2960638882c2` remains FAIL. The earlier 'not rechecked' and 'next verification' statements below describe that historical checkpoint and are now superseded by this successful recheck, not retroactively changed to PASS.

No audit finding is declared fully closed. A1 retirement/security prerequisite and remaining browser, production recovery, build/lint, source-bound bundle and independent Reviewer/release criteria remain open. No code changes, commit/push, migration, RUN or rollout in this turn; internal workflows remain excluded from add.

## Latest audit follow-up — 2026-10-10

Read current audit `42623e5543944e6acef1c6269b1716525b3869ed3353768779e59538595880fb`. This section supersedes current-state claims in historical sections below, without changing their results.

Implemented:

- A2: added lifecycle event enum and strict generating/persisted/failed payload definitions to `schemas/stream/project-stream-event.schema.json` (250 lines). Extended native stream tests to validate emitted envelopes against the real Ajv schema and reject extra/invalid fields.
- A2: extracted a bounded UI lifecycle reducer; duplicate/delayed events cannot regress terminal progress, cross-project/malformed signals are ignored, and missed generating is not fabricated. The shared fan-out remains connection-free; header has no interval or separate SSE connection. Added executable reducer/fan-out tests and updated old UI source assertions.
- A4: corrected loader coupling: diagnostics read failure no longer prevents authoritative artifact read/review. UI displays a diagnostic warning, and generic exception messages are not exposed through that warning.
- A4: added command-service fault injection for start/complete/fail persistence and publication failure. Assertions require core success/error preservation, exact persisted identity, no extra generation, and redacted diagnostic logs. Artifact store and Architecture are doubles in these tests; they do not prove process crash durability.
- A3: added a SQLite close/reopen readiness recovery test, using the real Markdown readback, handoff service and action. Intended assertions cover completed receipt retention, pending readiness after reload, one decision/child, replay without provider/ingestion, and no RUN. File Service and Registry readiness writes are doubles, not independent process/concurrency witnesses.

One focused check executed:

```text
node --test backend/tests/unit/plan-request-diagnostics.test.js backend/tests/unit/owner-chat-command-service.test.js backend/tests/unit/plan-readiness-recovery.test.js backend/tests/unit/plan-handoff-service.test.js backend/tests/unit/plan-lifecycle-projector.test.js backend/tests/unit/project-stream.test.js ui/nextjs/tests/coding-plan-events.test.js ui/nextjs/tests/coding-plan-approval.test.js
```

Result: FAIL, exit 1, `ready_for_review=false`. Run `VERIFY-RUN-d57a8789-0d33-4d51-a974-2960638882c2`; evaluated `2026-10-10T11:23:52.931Z`. Returned failure: readiness recovery fixture inserted nonexistent `plan_revisions.proposal_id`. Do not infer per-file PASS from this aggregate result.

Investigation also confirmed the production readback used the same nonexistent column. The actual parent `proposal_id` lives in the immutable child JSON artifact, not the SQLite index.

Corrections after FAIL (not rechecked):

- Markdown readback now joins indexed Registry identity without the nonexistent column, then validates child bytes/SHA-256, project/plan/revision/sprint identity and exact parent proposal binding from JSON. Missing/invalid child readback exposes binding recovery rather than treating the completed receipt as ready; exception content is not logged.
- The readiness fixture now stores child JSON bytes and computes its indexed digest, matching the existing storage contract instead of inventing a schema column. No migration added.

Current individual source identities (not an atomic run manifest):

- Stream schema: `52a27bc388ac0336f2f7b079ebe878568e05277b1028a9db60bc0254a98f6962`.
- Lifecycle/schema tests: `ede38a3154840157ee91b655486059d59983d754fc1641ee60995225cb2f0380`.
- Diagnostics tests: `6ed9d9c080811fcc700378a6301106ebf094afa4b4e17121b920464814d6c7cd`.
- UI events: `c63cdeed3c6a39adc0ce56f0dc3875a1c19c11527bcedcf905012d93566910a1`; tests: `6447b55246ff1a6383210b4b4dc110bd30b44a066714fb2a30b7149ee554568a`.
- UI loader: `1ce32d8870cba3dabf65392f159ba45146c6d92472232a52d136eb28730b73d3`; header: `fde1432333e7b48ac3796646c3812c348edc4e357f26097f5dfe2531073661b5`; approval UI tests: `7bcac2095306f1eccf02834af33864460f14527315959e0fa53ebcb3815f81dc`.
- Corrected Markdown store: `4ef0e0da62d7e1e109742b5c80e66aa486a963b4e4506867d1220506b91d70ad`; corrected readiness tests: `9b5b75911849ec8b18d3ed91f701e2301978dd2807dfb59f9e8b414f79241be6` (both AFTER the failed run).

Next verification: rerun the exact eight-file command above under another focused-check allowance. This turn used its one permitted check. No PASS for the corrected snapshot is claimed; no finding is closed.

A1 chat retirement/security prerequisite remains open. A2 browser two-tab/reconnect/no-polling network witnesses, A3 kill-process and production Registry-write evidence, A4 real persistence durability, and A5 build/lint/browser/accessibility/source-bound bundle/independent Reviewer remain open. No commit/push, migration, RUN, or rollout; unrelated worktree preserved and workflows excluded from add.


## Revision 2 projector retry — 2026-10-10

Owner explicitly authorized retrying the previously rejected projector edit. It was successfully applied through Forge, with no alternate tool or workaround.

- `backend/src/transport/sse/project-stream-publisher.js` now projects generating/persisted/failed events for the configured project only, requiring a valid request ID. Persisted requires plan ID, positive integer revision and lowercase SHA-256; failed requires a bounded safe error code.
- Output is a field allowlist: request correlation plus exact artifact identity or error code as applicable. Credentials, content, actor, conversation and approval claims are not forwarded.
- Added `backend/tests/unit/plan-lifecycle-projector.test.js`: positive/negative projection, redaction, missing/wrong project identity, malformed payload rejection, and native stream ingestion/delivery without conversation binding.

Focused check (one call):

```text
node --test backend/tests/unit/plan-lifecycle-projector.test.js backend/tests/unit/project-stream.test.js
```

Result: PASS, exit 0. Run: `VERIFY-RUN-04a7d894-bdc2-4e8b-9d59-84204a2cb7fd`; evaluated at `2026-10-10T10:58:46.503Z`.

Individual source identities recorded before the check (not an atomic manifest):

- Projector: `c21d78f7b5ae3089dc2f353a2850c98428a77deeb9bea68e10610e13519d92ca`.
- New tests: `1bcfaa9a1caa64815e37b55b877df92afa6a035eb9520935fcdf021d53b49b6e`.
- Existing stream regression tests: `4b9d16ad45d947261f66a90797f435a7ed005c73b316db717e8e2fd0193808df`.

No source/test edits followed that check. Only this report changed afterward. The result is service-reported; no raw TAP output, Node version or independent Reviewer verdict was provided. The two-file check does not verify prior diagnostics/readiness/UI edits, browser behavior or full lifecycle schema compatibility. Schema completion and the remaining A1–A5 criteria remain open; the worktree is not release-ready.

Git status/diff inspected: 82 changed files, none staged, no conflicts. The diff is broad and response-truncated; unrelated work is preserved. No commit/push was performed because the execution ledger includes unrelated historical changes and internal workflows, and Forge provides no path-selection/removal mechanism here. No RUN or rollout performed; workflows remain internal.

The checkpoint section below is historical and its no-check/projector-blocked statements are superseded only by this narrowly scoped retry evidence.

## Revision 2 checkpoint — 2026-10-10

The sections below preserve revision 1 evidence. Their PASS does not cover the subsequent revision 2 source edits.

Implemented but not yet verified:

- Extracted `plan-request-diagnostics.js` so start/complete/fail diagnostic persistence and lifecycle publication failures do not override core artifact success or the original core error. Successful degraded results include a diagnostic error code; logs omit exception content.
- Added correlated generating/persisted/failed publication from the `/plan` boundary through `projectStream.ingest`.
- Added completed-handoff readiness readback based on the exact child parent binding and Registry status. Coding selection retains approved/completed plans when readiness is not established.
- Added `coding-plan-events.js` and page/shared-hook wiring. The Architecture header no longer opens an independent stream or uses a five-second interval. It subscribes to the existing page connection and retains lifecycle transitions separately from authoritative refetch.
- Added lifecycle event names to the project stream allowlist.

Blocking incomplete boundary:

- The attempted change to `backend/src/transport/sse/project-stream-publisher.js` was rejected by automatic tool approval after HTTP 429/retry exhaustion. The rejection explicitly prohibits achieving the same change through a workaround without informed user approval.
- Readback confirms that file remains at `315740fb41d26b0928ac5d574279f24b7bb64c5d5d6f4b93dd68f9580ba57a42`, without plan lifecycle projection. Therefore the allowlist/producer/UI edits do NOT constitute working end-to-end lifecycle delivery. This intermediate worktree must not be represented as release-ready.
- Next required approved edit: validate and redact request lifecycle payloads in that projector, then complete the corresponding stream schema, regression/fault-injection tests and remaining revision 2 remediation. No alternate tool or indirect edit was attempted.

Still outstanding: retire chat approval after required security verification (A1), complete/test stream projection/schema and no-polling witnesses (A2), readiness error/restart evidence (A3), diagnostics fault-injection evidence (A4), rendered/browser/build and independent review evidence (A5).

No revision 2 check has run; there is no revision 2 PASS or acceptance. No commit, push, RUN or rollout was performed. Resume used checkpoint 55 and did not repeat completed source writes. This internal report remains excluded from Git add.


## 1. Implemented code

- Added a separate Architecture plan header to the `/coding` Sprint Plan column. It does not depend on the Sprint dashboard loading successfully.
- Added plan selection, immutable revision review, and visibility of approved plans whose handoff is incomplete or failed.
- Replaced the Markdown review modal's hidden chat `/approve` submission with a direct authenticated handoff API.
- Added `POST /forge/v1/plans/:id/:revision/handoff`. The server verifies authenticated owner, project, current revision, SHA-256, persisted approval, and existing artifact validation before using the existing handoff service.
- Client-supplied actor and conversation fields are not accepted. The conversation identity comes from the stored plan.
- Decision and handoff remain separate phases. A handoff failure does not erase the successful approval. The modal can continue an already-approved handoff.
- Added stable decision IDs within the mounted modal and an immediate double-submission guard.
- Added persisted `/plan` request diagnostics and `GET /forge/v1/plans/requests`: generating, persisted, failed, and interrupted states. Failure diagnostics expose sanitized error codes, not raw exception messages.
- Added `handoff_error_code` to Markdown revision readback.
- Added project-scoped stream invalidation, visible-tab polling every five seconds, reconnect/tab reconciliation, and protection against late responses from old loads.
- Preserved `/summary`, `/plan` artifact validation/storage, JSON plan consumers, existing approval choices, and execution gates.
- Approval/handoff does not issue RUN, dispatch Coder/Supervisor, migrate data, or roll out production changes.

## 2. Changed implementation and tests

Existing files changed:

- `backend/scripts/control-api-http.mjs`
- `backend/src/application/owner-chat-command-service.js`
- `backend/src/modules/governance/markdown-plan-store.js`
- `backend/src/transport/http/forge-v1-plan-routes.js`
- `backend/src/transport/http/forge-v1-router.js`
- `ui/nextjs/app/coding/page.jsx`
- `ui/nextjs/components/coding-workspace-monitor.jsx`
- `ui/nextjs/components/plan-review-modal.jsx`
- `ui/nextjs/lib/node-client.js`
- `ui/nextjs/tests/plan-registry-handoff.test.js`

New files:

- `backend/src/application/plan-approval-action.js`
- `backend/src/application/plan-request-state.js`
- `backend/tests/unit/plan-approval-action.test.js`
- `backend/tests/unit/plan-request-state.test.js`
- `ui/nextjs/components/coding-architecture-plans.jsx`
- `ui/nextjs/lib/coding-plan-loader.js`
- `ui/nextjs/tests/coding-plan-approval.test.js`

## 3. Focused verification

Executed one focused check for eight test files:

```text
node --test backend/tests/unit/plan-approval-action.test.js backend/tests/unit/plan-request-state.test.js backend/tests/unit/owner-chat-command-service.test.js backend/tests/unit/plan-handoff-service.test.js backend/tests/unit/markdown-plan-approval.test.js backend/tests/integration/human-plan-workflow.test.js ui/nextjs/tests/coding-plan-approval.test.js ui/nextjs/tests/plan-registry-handoff.test.js
```

- Result: PASS, exit code 0.
- Verification run: `VERIFY-RUN-93f6bbcb-b736-4a88-9aaf-bbec4ff10b95`.
- Service evaluation timestamp: `2026-10-10T10:00:04.543Z`.
- No implementation or test changes were made after this check; this report was written afterward.
- The service returned a final result, not raw TAP output, a test-case count, or a Node version. Those details are not asserted here.
- The service's execution identifier is not a Git commit SHA.
- Its broad historical change ledger is not an atomic source-bound manifest for this batch.

Covered evidence includes authenticated/exact-revision handoff guards, invalid client identity fields, non-approved decisions, request-state persistence/error redaction, project isolation, compatibility tests for existing command/handoff behavior, loader cancellation/late responses, and UI source-level assertions for the direct API flow.

This is service-reported focused verification, not an independent Reviewer verdict. UI tests include loader behavior and source assertions; they do not prove rendered browser behavior, keyboard/focus handling, or end-to-end provider execution.

## 4. Acceptance limits and remaining work

| Outcome | Current evidence | Still open |
| --- | --- | --- |
| O1 command compatibility | Existing command tests passed; artifact validation/storage preserved | Chat `/approve` remains active during the additive transition; its planned retirement has not been implemented |
| O2 Coding review UI | Separate header, selection, revision review and handoff continuation implemented | Rendered browser UX, accessibility and responsive validation |
| O3 request/realtime state | Persisted diagnostics, existing project stream invalidation and five-second visible-tab fallback | Dedicated plan lifecycle event producer/schema and missed-delivery/multi-tab end-to-end witnesses |
| O4 authenticated action | Direct handoff API and identity/approval guards covered by focused tests | Production authenticated end-to-end verification |
| O5 recovery | Durable handoff service reused; failed handoff retains approval; diagnostic readback added | Multi-process launch ownership, unknown provider outcome and crash/restart acceptance |
| O6 verification/rollout | Eight-file focused PASS | Browser E2E, applicable build/lint, source-bound run bundle and independent acceptance; no rollout performed |

Request interruption detection uses a local process identity/PID probe. It is diagnostic, not a multi-host lease or provider disposition witness. PID reuse and separate PID namespaces remain limitations. Unresolved generating records are retained rather than silently discarded.

Polling reconciles visible tabs; immediate lifecycle delivery is not claimed. A failed artifact read leaves the approval snapshot unavailable rather than approving from stale data.

The existing handoff service's process-local in-flight guard is not evidence of cross-process fencing. This batch does not close the separate execution-recovery R1–R6 findings.

## 5. Git and internal documentation

The inspected worktree contained 70 changed/untracked files, including unrelated changes outside these 17 source/test files. Nothing was staged. The whole-worktree diff exceeded the tool response limit, so a complete review of unrelated changes is not claimed.

No commit or push was performed for this batch. Forge's commit tool has no path-selection argument, and the execution ledger contains historical changes beyond this batch. Committing that combined set would risk including unrelated work. A batch-isolated authorized ledger/staging mechanism is needed before committing safely.

This report is internal under `workflows/`; it must not be added, force-tracked, or unignored. No migration, RUN, destructive action, or production rollout was performed.

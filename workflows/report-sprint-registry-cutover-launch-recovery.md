<!-- Records restart ownership guards, Registry submission coverage and source-bound verification gaps for unresolved provider launches. -->
# Sprint Registry: unknown-provider-outcome restart and submission follow-up

Date: 2026-10-09 UTC. Continues `workflows/plan-sprint-registry-cutover-execution-recovery.md`; no new plan, approval receipt, production RUN, rollout or legacy retirement authority is introduced. This follows the owner's architecture/evidence audit of launch ownership section 9, not an independent implementation verdict.

## 1. Recovery boundary remediation

Source inspection confirmed that production recovery previously released occupancy based on completed checkpoint or terminal Supervisor snapshot without consulting the current durable launch claim. This is a demonstrated missing guard in source, not a claimed production incident or independently reproduced pre-fix release.

- New `ticket-launch-recovery.js` checks the project-scoped Ticket Status Store for retained `details.launch_claim`. Any retained claim is conservatively unreconciled; it emits a reconciliation diagnostic and blocks automatic recovery action.
- `production-runtime.js` applies this gate before checkpoint/terminal-based occupancy release and before pending loop resume, including the REVIEWING recovery helper branch. It does not clear the receipt or infer provider termination from a terminal projection.
- The existing no-claim compatibility release behavior remains unchanged. Missing Ticket Status Store retains the existing legacy compatibility boundary; this is not proof that every production Registry configuration supplies the authority correctly.
- The previously approved integration failure catch is untouched. No stop/cancel semantics or provider cancellation acknowledgement was added.

This remains a read-before-action guard, not an atomic cross-process occupancy-release fence. A new claim created during an awaited snapshot/checkpoint read or release still requires R4 serialization. Workers, review migration and other consumers are not globally fenced by this recovery-loop guard.

## 2. Registry submission and individual RUN

- `assertDependencySubmission` no longer accepts omitted dependency intent when the request has Sprint basis, the current Ticket row has execution basis, or the ticket is registered in the supplied Registry. Missing identity returns scoped non-retryable reconciliation before workspace/occupancy/queue preparation.
- Supplying `direct_code: true` does not erase an existing Registry binding. Unregistered standalone work without Registry/execution basis keeps its current contract.
- Shared `ticket-run-dispatch.js` captures individual RUN dependency expectations when the authoritative Sprint basis exists and the caller omitted them. `captureDependencyExpectations` captures each dependency's current done execution/plan identity once, then synchronously revalidates the entire set before returning. Later admission boundaries use that same set rather than refreshing it.
- Registry review-resume with a retained launch claim is rejected before preparation. This addresses the unknown-launch bypass, not all review-resume provenance. A review-resume without a retained claim still requires separate source-bound completion/verification coverage.
- DAG callers already supplying captured expectations retain them. Legacy fixtures without an authoritative Sprint basis retain their compatibility path; no standalone workflow is forced into Sprint approval.

## 3. New restart and negative witnesses

`backend/tests/unit/ticket-launch-recovery.test.js` adds:

1. Six restart cases with retained launch claim plus completed checkpoint, COMPLETED/FAILED/NEEDS_HUMAN_REVIEW snapshots, and RUNNING/REPAIRING pending state. Each reconstructs the production runtime from file-backed Supervisor/checkpoint state and real SQLite launch evidence, recovers twice, and asserts no occupancy release, no interrupted-review publication, no agent.request enqueue and retained receipt identity.
2. Two no-retained-claim controls preserving completed-checkpoint/terminal release behavior.
3. Integration-boundary negatives for missing Registry intent, attempted direct-code bypass and retained-claim review-resume before preparation; an unregistered standalone validation control.
4. Individual authoritative RUN capturing empty dependency intent into dispatch and durable execution; missing dependency completion rejected by the capture helper.

Runtime restart uses two reconstructed runtime instances and persistent storage, with an injected occupancy fixture shared between them; it is not a new OS-process restart of the production occupancy service. Real SIGKILL/concurrent dispatch witnesses remain in `ticket-dispatch-recovery.test.js`, including its existing quarantine-write failure case. That case checks original cause/reconciliation error, no release/outcome, retained receipt, queue claim repair without redispatch and rejected replacement. It was included again in this check; no duplicate rewrite of the passed failure catch or queue implementation was needed.

## 4. Verification and correction — NOT accepted

Exactly one focused check was run:

```text
node --test backend/tests/unit/ticket-launch-recovery.test.js backend/tests/unit/ticket-dispatch-recovery.test.js backend/tests/unit/ticket-dependency-submission.test.js backend/tests/unit/supervisor-execution.test.js backend/tests/unit/ticket-run-dispatch.test.js backend/tests/unit/direct-code-supervisor.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/ticket-launch-ownership.test.js
```

Run `VERIFY-RUN-a88f48ed-3fb2-4af7-b4e3-fca991a6af26`, evaluated `2026-10-09T03:14:53.375Z`: **FAILED**, exit 1, `ready_for_review: false`.

Returned failures name two old execution-fencing fixtures: approved submission omitted required captured intent; a Registry-shaped failure test still expected generic outcome publication after the new missing-intent gate rejected submission. No full TAP totals, stdout or separate PASS verdict for the new matrix was returned. Absence from the failure list is not claimed as independent acceptance.

After the check, `ticket-execution-fencing.test.js` was corrected: durable fixture claims/submission carry `[]`; missing Registry intent must reject without publication; generic failure Project/execution identity is tested on standalone without Sprint basis. These corrected fixture bytes **have not been rerun**. Production source and the new source-manifest test were not changed after the check. No overall PASS is claimed for this increment, and no independent Reviewer verdict exists.

Historical PASS `VERIFY-RUN-5eb080b2-bb76-4f03-a5cd-36e66d63efa3` at `2026-10-09T02:42:40.531Z` and FAILED `VERIFY-RUN-e8d1e15b-fc48-4bef-bff6-18da623528a9` at `2026-10-09T02:36:06.071Z` retain their original results. The subsequent dispatch-recovery PASS at `2026-10-09T02:59:14.136Z` is documented separately; none is reassigned to the current recovery source.

## 5. Source binding inside the new run

The new test embeds `SOURCE_IDENTITIES` and verifies actual SHA-256 file bytes in both `test.before` and `test.after` hooks of the focused run. It does not infer the queue identity from an old report table. The exact declared manifest is:

| Source path under `backend/src/` | Expected SHA-256 in run hooks |
| --- | --- |
| `modules/supervisor/production-runtime.js` | `bf8af53b00e8455c860c9ae5a8304241676b758e26f7f1246d87c77cc6fb720e` |
| `modules/supervisor/ticket-launch-recovery.js` | `be74b0222137620a5111e1fd10edf68c1f5ca7778a232355fc67237bd6eddf69` |
| `modules/supervisor/durable-queue.js` | `ab7b69fdb8f3e3a2065900fc56d459495d864391f52cfba41a30433c0998d951` |
| `modules/supervisor/ticket-dependency-expectations.js` | `cf987d85b7b99e66b119ebfbac89f04f4f2823960ed63f504e971ba2991341ac` |
| `application/ticket-run-dispatch.js` | `7906c9cd543411358d0092db3e56b4e741527e293606544f7db9b248f6013161` |

New test identity: `backend/tests/unit/ticket-launch-recovery.test.js` = `3be61a71a5983d6cfd26eb5f4879a7e34b5783d939bd5e606d6a7d97f79846c0` (individual Forge write identity). Execution-fencing fixture during the FAILED run = `7c629386ad3a60c930061e245f9d7a5245b3101a684230cf7fb533f9d8f75b01`; corrected current fixture = `4a635216abab507a82729c0d484aa9aa2495ec0a6be9388bbf084f569afccc71` (not rerun).

This binds declared source identities to assertions in the new command, not to the earlier PASS. It is not an atomic snapshot of all dependencies or a retrievable raw manifest artifact from the verification service. Overall check remains FAILED until corrected fixtures are confirmed. Independent Reviewer should retrieve raw hook/test evidence and verify the declared hashes against a clean source snapshot before acceptance.

## 8. Confirmation of the final fixture correction

Date: 2026-10-09 UTC. The owner requested completion of the pending fixture verification. Forge read confirmed the final Registry/direct-code/legacy assertions in `ticket-execution-fencing.test.js`, SHA-256 `fbf18012bc509ffcbdfe005a32c471e5681bef54d33283422a881ac7a32a2788`, before the run. No source/test edits were made in this confirmation turn.

Exactly one focused check reran the six-file command shown in section 7. Run `VERIFY-RUN-aa17d26f-770c-462e-b753-2289621e8eb7`, evaluated `2026-10-09T03:48:25.185Z`: **PASSED**, exit 0, `ready_for_review: true`. Tests/scope passed; build/lint/typecheck were not applicable. This confirms the corrected fixture together with persistent occupancy recovery, actual occupancy regression, queue compatibility, launch recovery/source-hash hooks and dispatch crash/quarantine witnesses included in that command. No full suite was run.

The pending final-fixture rerun item is now complete. Historical run `VERIFY-RUN-0e051c14-445b-4b77-9fb6-4ef2d366dcfb` remains FAILED, as do the earlier failures; they are not rewritten or assigned the corrected source identity. Source-hash and child Node-version assertions execute within the passing test command, but the service still did not expose raw TAP/stdout, concrete Node version or an atomic source-run bundle in its response. No raw counts or independent Reviewer verdict are fabricated.

This is focused Coder/service-reported PASS, not full unknown-outcome or R1–R6 acceptance. Execution-only orphan continuation, asynchronous release/write fencing, all Registry consumers, projection/waiter repair, raw evidence/Reviewer/forecast and provider-disposition/availability limits remain as stated in section 7. No commit/push, production RUN, migration, rollout or legacy retirement was performed; only internal reports were updated.

## 7. Persistent occupancy and handoff compatibility evidence follow-up

Date: 2026-10-09 UTC. The owner identified the occupancy-double limit and uncaptured/expired-lease compatibility gaps. No new production implementation defect was asserted; this increment adds evidence, not another failure-handler rewrite. The production recovery guard, dependency capture and queue code remain unchanged.

### New witnesses

- `ticket-persistent-occupancy-recovery.test.js` persists a real Agent Profile and `createAgentOccupancyStore` claim in SQLite, links the actual claim ID to the Ticket launch receipt, saves checkpoint/terminal snapshots, then closes the original database connection. A separately spawned Node process reopens those stores and invokes actual `production-runtime.recover()` twice; the parent independently reopens SQLite afterward.
- Four retained-claim cases cover completed checkpoint without Supervisor snapshot, and COMPLETED/FAILED/NEEDS_HUMAN_REVIEW Supervisor snapshots. Assertions require the same active claim, NULL `released_at`/`release_reason`, working profile, retained receipt, no interrupted-review event, no agent.request job and no provider invocation. Occupancy is not wrapped or substituted with a double.
- Two no-retained-launch controls require actual persisted release and ready profile, preserving checkpoint and terminal compatibility. Provider execution remains isolated; these fixtures do not claim remote termination or production rollout.
- `handoff-queue-compatibility.test.js` uses the real file queue/lock with deterministic clock. It covers uncaptured request deduplication, claim/reject retry, max-attempts dead-letter, acknowledgement, expired-lease recover/reclaim, direct expired-lease reclaim, captured historical expired-lease quarantine through both claim and recover, unexpired captured lease retention, completed acknowledgement and mixed captured/legacy fairness.

### Focused result and remaining fixture correction

Exactly one focused check ran:

```text
node --test backend/tests/integration/ticket-persistent-occupancy-recovery.test.js backend/tests/integration/agent-occupancy.test.js backend/tests/unit/handoff-queue-compatibility.test.js backend/tests/unit/ticket-launch-recovery.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/ticket-dispatch-recovery.test.js
```

Run `VERIFY-RUN-0e051c14-445b-4b77-9fb6-4ef2d366dcfb`, evaluated `2026-10-09T03:38:09.831Z`: **FAILED**, exit 1, `ready_for_review: false`. Returned failure list names one execution-fencing fixture expecting `task.failed` for direct-code. Source inspection of `ticket-execution-failure.js` confirms direct-code intentionally suppresses ticket outcome publication; the prior fixture correction still conflated that path with unregistered legacy ticket execution. No separate acceptance/PASS is inferred for the new witnesses from absence in the returned failure list.

After the check, the fixture was corrected to assert: missing Registry intent rejects without publication; direct-code suppresses publication; an unregistered legacy ticket request without Sprint basis preserves Project/execution identity on generic failure. Only this test changed after the check, not production behavior. At the end of that correction turn, the fixture had not been rerun. The confirmation recorded in section 8 now supersedes that unverified state; independent/full recovery acceptance remains open. Historical failures and earlier PASS results retain their original status.

| New/current test artifact | Individual Forge SHA-256 |
| --- | --- |
| `backend/tests/fixtures/ticket-occupancy-recovery-worker.mjs` | `201776eeafb6650cc69c1e70de14918cbc6a4a7ea52192cc366be14b769f0221` |
| `backend/tests/integration/ticket-persistent-occupancy-recovery.test.js` | `d1b51cd5e9fce7bed23f46d2def14cbfe4994b6393e8d3a658ba555a89d150d4` |
| `backend/tests/unit/handoff-queue-compatibility.test.js` | `f7aa2e438af21c14ca460c8d35567e982225e9ac54f14772808d35b20142365f` |
| `backend/tests/unit/ticket-execution-fencing.test.js` after correction | `fbf18012bc509ffcbdfe005a32c471e5681bef54d33283422a881ac7a32a2788` |

The execution-fencing fixture used by the FAILED run was `4a635216abab507a82729c0d484aa9aa2495ec0a6be9388bbf084f569afccc71`, not the corrected identity above. The child returns JSON with observed Node version/PID, actual claim/profile/receipt observations and SHA-256 identities for runtime, launch recovery, occupancy store and queue. Parent tests assert a different PID, matching Node version and the expected source hashes; compatibility tests also hash-check queue before/after. Parent prints child observations to test stdout. The Forge check response does not expose that raw stdout, concrete Node version, TAP totals or artifact reference/hash, so no retrievable raw bundle or exact version is claimed in this report. This is stronger test instrumentation, not an atomic source snapshot or Reviewer verdict.

Availability remains safety-first: unresolved receipts block retry/replacement/release; no provider-stop proof or automatic recovery deadline exists. Execution-only orphan continuation, non-empty individual RUN/producer/resume/revision-reader convergence, R4 write-time serialization, R3 projection/waiter repair and R6 raw evidence/independent verdict/owner-capacity forecast remain open. No full recovery claim is made.

Forge status/diff were inspected: 26 changed paths, 12 staged, 10 unstaged and 11 untracked with overlap; prior edits preserved, diff truncated. No commit/push, force-add workflows, migration, production RUN, legacy retirement or rollout was performed. All new files and the corrected fixture remain below 250 lines.

## 6. Remaining gates and Reviewer handoff

- Confirm corrected execution-fencing fixtures with the focused command above; do not change the historical FAILED result into PASS.
- Independently verify recovery does not release/resume the retained owner in the named snapshot/checkpoint cases, and contrast no-claim controls. Assess production occupancy durability and asynchronous replacement-at-release windows separately.
- Verify Registry submission classification and individual RUN capture across non-empty real dependencies, wrong/missing identity, pending_request producers, runtime workers, occupancy/checkpoint recovery and revision readers. Registry review-resume without retained claim still needs completion/source binding; not all bypasses are closed.
- Keep availability limits explicit: retained claims block automatic release/resume/replacement until a legitimate reconciled/fenced provider disposition exists. No receipt cleanup, provider-stop proof or reconciliation authority was invented.
- Full R1/R2 admission/continuation, R3 waiter/projection repair, R4 write-time fencing, R5 convergence, R6 independent acceptance/raw evidence/forecast and O1–O7 carry-forward gates remain open.

All new/changed source files remain at or below 250 lines; production-runtime is 246 lines. The glossary was read without mutation, and new functions/files have business-purpose comments. No UI files changed or UI runtime verification was claimed.

Forge status/diff were inspected: 23 changed paths, 12 staged, 10 unstaged and 8 untracked with overlap; existing edits were preserved. Returned diff is truncated and not a full accumulated manifest. No commit/push was attempted while corrected fixtures remain unverified and the prior accumulated Git-authority refusal remains unresolved. Internal workflows reports remain local, without force-add or ignore changes. No production RUN, migration, rollout, legacy schema/store retirement or stop/cancel contract change was performed.

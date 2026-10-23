<!-- Records Ticket execution identity remediation and focused evidence without replacing Architecture or Reviewer acceptance. -->
# Sprint Registry — Ticket execution identity remediation

Date: 2026-10-08. **Verdict: partial O2/O3/O5 remediation; full O1–O7 cutover is not accepted.**

## Baseline and scope

Read the requested current audit in full (250 lines) and follow-up 0d in full (51 lines, SHA-256 `110466a5b260aacfbb4eb52869268666b15b7a5e26a0245839a759620b223e5e`). The current index now points to follow-up 0f; read that entire file too (58 lines, SHA-256 `6aa860acc1cbb7db05265e254ff8243651fcf9a9cd4a09288cfa580ac1f32fae`). Existing Registry CAS/draft basis/Sprint callback/Coding diagnostic remediation was retained. Architecture audit conclusions and approved bytes were not edited.

This batch addresses persisted Ticket execution ownership, stale terminal/failure writes, done reuse and dashboard parity. It does not introduce a new storage authority/schema or claim a transactional queue admission protocol.

## Implemented

- Added immutable execution-identity helpers. Plan evidence matches exact Project/Sprint/plan ID/revision/path/hash. Events and failure callbacks additionally require the same execution ID and captured scheduling version. Ticket ID is scoped by the status table's existing composite Project/Ticket primary key.
- `TicketStatusStore.beginExecution` persists a unique execution ID and the observed basis in existing `details_json` with versioned CAS/history. Explicit RUN from pending/failed/review-needed or explicit fresh done can claim a new execution; an already running/reviewing row cannot be replaced by a second process or by a restarted in-memory dispatcher. This is a durable status claim, **not a queue admission receipt**.
- Added optional `expectedVersion`/`expectedExecutionId` preconditions to status updates. Existing phase writers preserve stored execution identity; retry/reconciliation transitions retain it unless the explicit new-execution method replaces it. Legacy callers without new preconditions remain compatible.
- Shared Ticket RUN rechecks its original Sprint version after checkpoint/resume reads and claims execution before clearing checkpoint/protocol/conversation state. A stale checkpoint-read basis now fails before claim/clears/submission. Clear failures are caught in the owned execution lifecycle; late failure catch applies only to the original execution ID and status version, never the newer attempt.
- Production pre-submit boundary is wired with Ticket Status Store and checks current ownership, then forwards `execution_id` with `sprint_basis`. New claimed RUN responses include the optional execution ID used by internal DAG waits. Existing unclaimed compatibility boundaries remain; this is not full entrypoint convergence.
- Integration terminal producers propagate Project and original execution ID/basis from their submitted request payload. Review-only captures its status identity before asynchronous work and rejects an obsolete identity before final status readiness/publication; it does not reload a new expectation for an old review callback.
- Guarded terminal bridge rejects missing/old/foreign/tampered basis or execution events before applying status. It supplies status version/execution ID to CAS and **does not re-read/retry an old event after a guarded conflict**. Guarded duplicate replay relies on committed terminal status rather than an in-memory seen key, so a wrong event cannot poison the subsequent valid event with the same request/correlation key. The legacy unclaimed event branch keeps its prior compatibility behavior.
- Production DAG with an execution-aware status store uses the new fenced runner/waiter. Done reuse requires stored execution evidence for the same immutable plan, not ID/status alone. Waits require the submitted execution ID and persisted completion; event type alone cannot open a dependency. Same-Sprint dependencies use the captured basis; external dependencies resolve current Registry binding and match its immutable plan. A read after subscription handles completion committed before the listener was installed. Invalid/missing legacy completion evidence fails closed for reconciliation rather than being synthesized.
- Registry dashboard now presents `untracked`/zero progress for status without matching execution evidence or status belonging to another immutable revision. Existing `untracked` is reused; no new public status enum was invented. It also rechecks observed Registry versions after projection and rejects an intervening scheduling change. This is a version-fenced projection, not a globally atomic multi-store snapshot.

## Verification

One focused check:

```text
node --test backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/ticket-status-store.test.js backend/tests/unit/terminal-bridge.test.js backend/tests/unit/ticket-run-dispatch.test.js backend/tests/unit/sprint-run-basis.test.js backend/tests/unit/sprint-dag.test.js backend/tests/unit/direct-code-supervisor.test.js backend/tests/unit/ticket-human-review.test.js backend/tests/integration/coding-registry-dashboard.test.js
```

Forge returned **passed**, exit **0**, run `VERIFY-RUN-939ccc1c-24c4-40ff-b1f3-a92ef9c9630c`, evaluated `2026-10-08T22:56:53.848Z`. Independent Reviewer verification remains pending. Exact Node version, TAP totals/skips and raw-output hashes are unavailable from the tool result and were not guessed. No source edits followed this run; reports only were updated.

Count clarification (2026-10-09): the unchanged test source at SHA-256 `7c629386ad3a60c930061e245f9d7a5245b3101a684230cf7fb533f9d8f75b01` contains ten top-level `test(...)` registrations, at lines 53, 67, 86, 100, 116, 128, 138, 150, 166 and 176. Follow-up 0g states nine; this differs from the current source and should be reconciled by Reviewer, not silently copied into the report. Phase identity preservation is part of the first case, not an extra registration. The ten registrations cover claim/phase preservation; terminal identity/reconnect; guarded CAS conflict; delayed failure; stale-before-clear; production ownership/payload; wait ordering; immutable replan parity; persisted DAG completion; and actual integration failure publication. Registration counts are not total runtime TAP counts.

Registry/approval/status fixtures use actual SQLite and immutable storage. Controlled submission, provider gateway and ordered event-bus doubles isolate timing; the production integration failure producer is exercised with a fake provider, not a real agent. The reconnect witness rebuilds the bridge; the persistent claim witness opens another SQLite connection. Neither is a killed-process recovery drill. Existing status/bridge/RUN/Sprint/DAG/SDK/human-review/Coding regressions were included. No browser, interactive controls, visual/accessibility review, load, migration/restore/rollback, lint/typecheck/build, full suite or production approval/RUN was performed.

## Exact source identities

Individual Forge identities, not an atomic whole-repository snapshot. This batch changes eleven code/test files plus this report and the current report index; the verification session's broader changed_paths is not this batch's diff.

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/projects/ticket-execution-identity.js` | `584dc1eca0f31d2d4adafd082eb241ae191b70816bb0f73a2d9e914a1e1def8d` |
| `backend/src/modules/projects/ticket-status-store.js` | `23fdc03c846a7e79a134cee7259906d8051f9ebef93925fddede3222eab5a173` |
| `backend/src/application/ticket-run-dispatch.js` | `6ad8e99ec822ef4e860bb6dfdcc9270851b6a35bdac1e310a6fc30d4eec4eeec` |
| `backend/src/application/approved-ticket-dispatch.js` | `68a29fe4d475176943690e3e2e286ddfadde3527add43321d23fd919609ca1c3` |
| `backend/scripts/start-control-api.mjs` | `68c727d90cdf85b8c98ea3b830601475cde8ae399955b0de937de195760dc6ec` |
| `backend/src/modules/supervisor/terminal-bridge.js` | `adf2da928021f682a953c1b137bb6c44ec259dc27335ecc1ce78c19f896e6942` |
| `backend/src/modules/supervisor/nodeforge-task-integration.js` | `58dd16c47160dcb978756cfdc0f87cbfe0be2aeb331226827c1c96e37d055ea4` |
| `backend/src/modules/supervisor/sprint-execution-wait.js` | `dde23536ffdd01509cc7b7ae377e713939a81fe8c1e6783db5664aa009407d40` |
| `backend/src/modules/supervisor/sprint-dag.js` | `9f9cdbd369c311b8cc2562c3bee2c43d2004cd96236b2e2953d3edc0e801bed1` |
| `backend/src/application/registry-dashboard.js` | `6134b297149c984c47f5502e7a27c5c0bfe131905c11ca4b3339b834a7bf373f` |
| `backend/tests/unit/ticket-execution-fencing.test.js` | `7c629386ad3a60c930061e245f9d7a5245b3101a684230cf7fb533f9d8f75b01` |

## Remaining acceptance work

- **O5 admission:** status claim/pre-submit checks and payload identity are not atomic scheduling-to-queue admission. Need durable pending/committed/orphan receipt/outbox or equivalent protocol, pause inside actual enqueue/admission with block/rebind, cross-process full RUN, killed-process crash/restart/reconciliation and replay/dedup. A running/reviewing claim after a crash requires reconciliation; automatic redispatch was not added.
- **O2/O5 clear/recovery:** stale-before-claim clears are now prevented, but checkpoint/protocol/conversation clearing is not all-or-nothing or archived for crash recovery. A process can fail partway through clears. Claiming status and queue/agent occupancy/workspace commits are separate. No rollback of these side effects is claimed.
- **O2/O5 all producers/parity:** unclaimed compatibility paths and generic status writers still need entrypoint inventory/required execution preconditions. Review-only workspace integration/checkpoint changes occur before the final identity guard and are not made atomic/recoverable by this patch. Queue-based Supervisor review/revision events, reconnect with an in-flight wait, external-dependency races and concurrent scheduling/status across processes need broader witnesses. The current wait protocol requires the production bridge's ordered committed-status delivery; it is not a durable replay subscription system.
- **O2/O4/O5 replay:** guarded Ticket status is persisted before the compatibility Roadmap/memory projection. Failure of those later writes is not repaired by duplicate status replay. File/index/approval/bind/handoff/receipt/event durable recovery, upstream stale-before-draft-entry intent and committed-receipt continuation remain open. Service recovery metadata is still not a durable reconciliation job.
- **O1/O2/O3/O4 authority/UI:** detail/graph/intake/review/writers/handoff and constructor legacy dependencies remain to converge. Dashboard status parity was strengthened, not full multi-store atomic snapshot/parity. Active mounted browser/controls/SSE/remount/recovery and authorized full-inventory operational continuation remain pending.
- **O6/O7:** full per-version/source/link/approval inventory, same-ID historical conflict decisions, exact readiness/cutover state, historical upgrade provenance, consistent backup/restore, crash/resume/rollback preserving new writes/events and independent Reviewer/human rollout/retention decisions remain blockers. No legacy store/schema was retired/dropped and no migration or production rollout was performed.

## Git handoff

Forge `git_status` and `git_diff` were inspected before attempting `commit_changes` with message `fix(tickets): fence execution claims and immutable completion evidence`. The working tree also contains unrelated filesystem/tool-policy edits; these were preserved and are not claimed as this patch. The diff output was truncated, so it is not evidence of a complete review of those unrelated edits.

The commit attempt failed with `GIT_ADD_FAILED`: `/workflows/` is ignored and Forge could not stage the report paths. No commit SHA was returned; no push was attempted. Source changes and reports remain in the working tree. Resolving the ignored report staging policy requires a human decision; this patch did not un-ignore or force-track workflows.

<!-- Records dependency revalidation remediation and its focused evidence without granting cutover acceptance. -->
# Sprint Registry — Dependency revalidation follow-up

Date: 2026-10-09 (UTC). **Verdict: partial O2/O5 remediation; O1–O7 cutover remains unaccepted.**

## Audit baseline

Read all 250 lines of `report-sprint-registry-cutover-current-audit.md` and all 51 lines of the requested `report-sprint-registry-cutover-follow-up-0d.md`. Also read the latest linked 0g follow-up (57 lines), which supersedes historical claimed-execution findings. Architecture documents and approval/plan bytes were not edited.

| Audit | Individual Forge SHA-256 |
| --- | --- |
| Current audit | `b505a90912641b17938e4ceb5300d85e1551905b20778669d4f1d91548a3ee49` |
| Follow-up 0d | `110466a5b260aacfbb4eb52869268666b15b7a5e26a0245839a759620b223e5e` |
| Follow-up 0g | `742309d0fd6a3ff064fdaea506f3a5915ac4d1799891f94f48d6d993a210f922` |

This batch addresses the 0g external-dependency resolve/wait race, not durable queue admission or the entire cutover protocol. Previously implemented execution ownership, terminal CAS fencing and dashboard parity remain intact.

## Implementation

- The fenced production DAG records each dependency's original immutable plan and execution ID before waiting. Dependency basis must be valid and belong to the requested Project.
- After all dependency waits, external dependencies are resolved again through Registry lookup; local dependencies are checked against the current scheduling record. A rebind or disallowed lifecycle state fails closed with scoped, non-retryable `TICKET_EXECUTION_RECONCILIATION_REQUIRED` and the affected Ticket ID.
- After asynchronous resolution finishes, a synchronous final pass rechecks every captured Registry version/plan and persisted Ticket completion. This detects an earlier dependency changing while a later dependency is being resolved, including same-plan block/ready ABA during that resolution window.
- The original completion execution ID must still own the dependency's done state. A newly completed replacement execution is not silently substituted for the observed dependency attempt.
- Same-plan lifecycle progress to `done` remains valid. A dependency Sprint becoming done changes scheduling version legitimately; completion evidence is still matched by immutable plan and original execution, not by requiring the pre-wait scheduling version forever.
- No new authority, database schema, public lifecycle enum, automatic retry, migration or RUN was introduced.

## Focused verification

One check was run:

```text
node --test backend/tests/unit/sprint-dependency-revalidation.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/sprint-dag.test.js
```

Forge returned **passed**, exit **0**, run `VERIFY-RUN-0c539eef-2a42-4d30-8def-a6e8529c3565`, evaluated `2026-10-09T00:10:05.806Z`, ready for review. This is Coder-run evidence, not independent Reviewer acceptance. No source edits followed the check; reports only were updated.

The new test file registers six scenarios:

1. Actual approved dependency rebind while waiting blocks dependent dispatch.
2. Dependency block while waiting blocks dependent dispatch.
3. Same-plan block/ready ABA during a later dependency lookup is rejected.
4. A replacement dependency execution during resolution is rejected even if it has already completed.
5. Same immutable dependency progressing through running to done allows dependent dispatch.
6. A foreign-Project dependency basis is rejected before waiting or dispatch.

Fixtures use real disposable SQLite, immutable plans/approvals, Registry/status stores, the production fenced runner and terminal bridge. The event bus and the asynchronous lookup boundary are controlled doubles, not production persistent delivery or killed-process recovery witnesses. Existing execution-fencing and legacy DAG tests were rerun in this command. Six scenario registrations are not a claim about total TAP counts. Node version, raw output/artifact hashes and pass/fail/skip totals were not returned by Forge and are unavailable.

No UI files were changed. No browser, mounted controls, visual/accessibility test, full suite, lint/build/typecheck, production agent, rollout, migration, backup/restore or crash drill was run. This batch does not provide new UI acceptance evidence.

## Source identity

Individual Forge checksums, not an atomic whole-repository tested snapshot:

| Changed code/test | SHA-256 |
| --- | --- |
| `backend/src/modules/supervisor/sprint-execution-wait.js` | `b3d59b3647f3c457b3c1093ca020b160ed3a54c451bd971e9b836d49536048db` |
| `backend/tests/unit/sprint-dependency-revalidation.test.js` | `e1cc5373da64140514638c7939e2eb7ffd5cbe72edad47219c8b4163e9be3898` |

The verification tool's broader changed_paths contains accumulated session changes and is not this batch's scope. Existing unrelated edits were preserved.

## Remaining boundaries and acceptance work

- Revalidation is a pre-dispatch guard, **not atomic scheduling-to-queue admission**. A mutation after the final check or during actual submission still requires a durable admission/receipt/outbox protocol linking dependency expectations, Ticket execution, queue, occupancy and workspace commits.
- This guard accepts current same-plan completion after legitimate scheduling lifecycle progress. It does not reconstruct all lifecycle changes that occurred while waiting or prove cross-process serializability.
- If a terminal event is persisted but its status application/notification is missed, the current waiter can still remain pending. Persistent event application, projection repair and waiter/reconnect recovery remain open. No duplicate-event delivery semantics were changed.
- Partial checkpoint/protocol/conversation clears and review workspace/checkpoint side effects still lack an all-or-nothing or durable recovery disposition. Producer/compatibility/status-writer inventory and required execution preconditions remain open.
- Authority convergence across detail/graph/intake/review/writers/handoff, exact committed receipt continuation, active Coding controls/SSE/unmount recovery, full authorized inventory and full O1–O7 coverage remain open.
- O6/O7 require historical upgrade provenance, full per-version/link/approval reconciliation, consistent backup/restore, crash/resume/rollback preserving new writes/events and independent Reviewer plus human rollout/retention decisions. No legacy schema/store was retired or dropped.

## Git handoff

Forge `git_status` and `git_diff` were inspected before `commit_changes`. Status reported a dirty tree with 45 changed paths, including accumulated prior edits and unrelated filesystem/tool-policy changes, which were preserved. Diff output was truncated and is not a complete review of those unrelated changes. This batch changes two code/test files plus reports; unrelated paths are not claimed as this implementation.

The commit attempt (`fix(sprints): revalidate dependency completion before dependent dispatch`) failed with `GIT_ADD_FAILED` because `/workflows/` is ignored. No Git commit SHA was returned and no push was attempted. Code/tests/reports remain in the working tree. No force-add, ignore-policy edit or deletion was performed. A human decision on ignored report staging is still required. The verification tool's commit_id is not treated as a Git commit SHA.

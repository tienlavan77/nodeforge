<!-- Records bounded crash/restart dispatch evidence and remaining execution recovery criteria without granting RUN or rollout authority. -->
# Sprint Registry: dispatch orphan and response-loss recovery increment

Date: 2026-10-09 UTC. Implementation continues `workflows/plan-sprint-registry-cutover-execution-recovery.md` (revision 1, SHA-256 `80cbcae0d1b81e5c4516a313c0f504cc058556e827f5c68557dc95196961eba2`). This is an implementation report, not a replacement plan, approval receipt, production RUN permission or independent acceptance.

## 1. Scope and implementation

The owner prioritized R1/R2 crash admission, R5 consumer coverage, R4 write fencing, R3 repair and unknown outcomes. This increment addresses the queue replay boundary for captured-intent inline handoffs and adds real shared-dispatch process witnesses. It does not close all five priorities or reopen the previously passed failure-handling implementation.

Changed production file: `backend/src/modules/supervisor/durable-queue.js`.

- `sender.handoff` records owning a `payload.dependency_expectations` field are classified as captured inline handoffs, including historical records without a new marker. No new schema or storage authority was introduced.
- `claim` persists their existing `dead_letter` disposition with `reconciliation_required: true` and reason `inline_execution_reconciliation_required` instead of granting a worker lease. Original request, execution, payload, job identity and attempts are retained.
- `recover` applies that disposition to queued captured handoffs, and to expired leased captured handoffs, instead of returning them to dispatchable queued state. Already quarantined records are not replayed or repeatedly repaired.
- `reject` cannot turn a captured inline handoff into ordinary retryable queued work.
- If disposition persistence fails, `claim`/`recover` propagate the storage error and return no lease. No provider launch or occupancy release is initiated by this mechanism.
- Other queue names, handoffs without captured dependency intent, and successful inline `ack` retain their existing paths. `agent.request` remains the production Sender worker queue.

This is a conservative no-redispatch disposition, not automatic continuation or proof that a process/provider stopped. A queued record can still belong to a live inline execution; disposition does not cancel that execution, clear its receipt or release occupancy. Such an execution may still complete and acknowledge its job through its existing owner. Exact authority validation remains at the inline launch claim, not in a projection or queue reason string.

## 2. New process witnesses

Files:

- `backend/tests/fixtures/ticket-dispatch-recovery-fixture.mjs`: disposable real SQLite authority, immutable approved fixture plan, governed tool registry, file-backed handoff queue, shared Ticket RUN -> approved dispatch -> actual integration. Production provider and occupancy service are controlled fixtures, not live services. Fixture approvals exist only in temporary test storage.
- `backend/tests/unit/ticket-dispatch-recovery.test.js`: seven defined scenarios, including a four-case SIGKILL matrix. This is a source scenario count, NOT raw TAP totals.

| Scenario | Boundary and assertion | Limit |
| --- | --- | --- |
| Kill after execution claim | Shared RUN commits execution, pauses at checkpoint clear, is SIGKILLed; restarted RUN cannot replace running identity; no provider invocation | No job exists yet; no automatic orphan continuation/release is implemented |
| Kill after queue save | Real file queue save commits and pauses before enqueue returns; kill also leaves its lock behind; restart recovers stale PID lock and retains the job as non-dispatchable evidence | Does not establish a transaction spanning SQLite and queue file persistence |
| Kill after launch claim | Real SQLite launch transaction commits, then process pauses before returning to the provider call; restart cannot lease or replace the captured execution | No provider termination proof is needed/claimed for this pre-call witness |
| Kill after provider invocation | Fixture durably records one invocation and pauses without a response; SIGKILL/restart keeps execution/launch identity and never queue-replays it | Controlled provider records invocation, not an external provider cancellation acknowledgement |
| Concurrent shared RUN | Two independent Node processes execute the real dispatch stack for the same ticket; one reaches provider, competitor is rejected; one launch history entry and invocation survive response loss | Single host, one target, empty dependency set; not distributed or full DAG admission coverage |
| Quarantine write failure | Provider error followed by failed disposition persistence keeps original cause/reconciliation error and receipt, with no release or generic failure outcome; next claim repairs retained queued evidence without leasing it; retry cannot invoke provider again | Occupancy/release and event sinks are fixtures, not cross-process production occupancy recovery |
| Disposition storage failure/queue isolation | Failed claim/recover disposition write propagates error without a lease; `agent.request` still leases equivalent ordinary work | Memory-store boundary witness; file-backed crash witnesses are separate rows above |

SIGKILL tests synchronize at exact durable boundaries through IPC; they do not rely on delays to approximate the crash point. Parent cleanup awaits child exit before deleting only temporary fixture storage.

## 3. Focused verification

Exactly one check was run for this implementation increment:

```text
node --test backend/tests/unit/ticket-dispatch-recovery.test.js backend/tests/unit/ticket-launch-ownership.test.js backend/tests/unit/ticket-dependency-submission.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/ticket-run-dispatch.test.js backend/tests/unit/ticket-execution-failure.test.js backend/tests/unit/supervisor-execution.test.js
```

Run `VERIFY-RUN-18c507ed-9f0e-49c1-9008-73b4ab8cc0f3`, evaluated `2026-10-09T02:59:14.136Z`: **PASSED**, exit 0, `ready_for_review: true`; tests/scope passed. Build, lint and typecheck were not applicable. No full suite, browser UI test, migration, production provider RUN or rollout was executed.

The service did not return raw TAP totals, full stdout, Node version or an atomic source manifest. This is Coder/service-reported evidence pending independent Reviewer verification, not an independent verdict. Historical FAILED runs remain FAILED; earlier source identities and PASS results retain their original scope.

| New/changed file | Individual Forge SHA-256 |
| --- | --- |
| `backend/src/modules/supervisor/durable-queue.js` | `ab7b69fdb8f3e3a2065900fc56d459495d864391f52cfba41a30433c0998d951` |
| `backend/tests/fixtures/ticket-dispatch-recovery-fixture.mjs` | `208a9160590b4645de24503cae868e49c35b17578c1af83f93f4747dc9e6620e` |
| `backend/tests/unit/ticket-dispatch-recovery.test.js` | `7b9b95b356f2c8e1529a996acdde9909ed96cbb8d002985b599aa0d927f4fd0c` |

Identities are individual edit/write results, not an atomic snapshot covering the check's entire dependency graph. No source/test was changed after this PASS. New functions/files have English business-purpose summaries; the glossary was read and not edited. All new/changed source files remain below 250 lines.

## 4. Consumer boundary inventory delta

This supplements, rather than replaces, the broader inventory in `workflows/report-sprint-registry-cutover-launch-ownership.md`.

| Actual path | Current boundary and disposition | Remaining criterion |
| --- | --- | --- |
| Shared `ticket-run-dispatch.js` with supplied captured intent | Persistent execution/version gate before approved dispatch; killed running claim rejects restarted RUN | Admission receipt and safe continuation before queue save; no automatic repair of orphan status/preparation |
| `approved-ticket-dispatch.js` -> `nodeforge-task-integration.js` | Original plan/execution/dependency expectations checked through preparation; inline launch receipt precedes provider | Full admission protocol and side-effect fencing during preparation/integration still open |
| `sender.handoff` claim/recover/reject | Captured inline evidence cannot become queue-authorized redispatch, including orphan before quarantine | Owner-driven continuation and reconciled disposition remain absent |
| `production-runtime.js` Sender worker | Search confirms worker consumes `agent.request`, not `sender.handoff` | Runtime resume, pending-request identity propagation and other recovery paths are not closed by this guard |
| Individual RUN without supplied expectations | Existing compatibility exemption in dependency validation remains unchanged | R5 convergence must capture/require exact intent on Registry-owned paths without breaking standalone boundaries |
| `review-revision-resume.js` historical reader | Search identifies a separate handoff reader of review findings; queue lease exclusion is not a reader ownership gate | Revision/source ownership gate and negative tests remain pending |

No claim is made that all Registry consumers have been inspected, gated or retired. Missing/supplied-wrong identity coverage across pending_request, occupancy/checkpoint recovery and revision readers remains a required R5 batch.

## 5. Acceptance and next delivery ledger

- R1/R2: new evidence covers the listed real dispatch crash/restart and concurrency paths. Durable admission spanning claim/queue/launch, safe continuation for execution-only orphans, arbitrary duplicate/response-loss continuation and all consumer boundaries remain open.
- Unknown outcomes: quarantine-write failure and handoff lease/recovery bypass now have bounded witnesses. Retained receipt and occupancy cannot establish remote termination; availability remains intentionally blocked until reconciled/fenced. No automatic receipt clearing or replacement permission was added.
- R4: no findings/checkpoint/preparation/review-only/integration/ledger write fencing was added here. Pre-write checks are not claimed to be cross-process serialization.
- R3: projection/waiter missed-terminal/reconnect/restart repair remains open.
- R5: consumer inventory delta above is bounded, not full convergence. Next source work should require captured identity on actual Registry-owned individual RUN and propagate ownership on resume/recovery producers/readers.
- R6: independent verdict, raw source-bound bundle and owner/capacity-based forecast remain pending. No calendar estimate or acceptance is fabricated.

Reviewer handoff: verify the exact command and identities, inspect the SIGKILL/competing-process witnesses versus fixture boundaries, validate no lease on failed disposition writes, and test compatibility of non-captured handoffs/other queues. Independently review availability and any bypass of launch ownership before closing individual criteria. Repository tools do not supply independent Reviewer dispatch, so this is a pending handoff artifact, not a recorded verdict.

## 6. Git and internal artifacts

Forge `git_status`/`git_diff` were inspected. Status shows 20 changed paths, 12 staged, 7 unstaged and 6 untracked (overlap); prior edits were preserved. Returned diff is truncated and does not include a complete staged/untracked source manifest. This increment changes one production file and adds two test files, not the whole accumulated tree.

No commit/push was attempted: the earlier accumulated-history mutation refusal has not been superseded by explicit Git authority for that batch. No workaround was used. Internal workflows documents remain local and are not force-added or unignored. No legacy store/schema retirement, stop/cancel contract change, migration or rollout was performed.

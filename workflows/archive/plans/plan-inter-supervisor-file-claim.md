# Plan — Inter-Supervisor File-Claim Coordination (Wait Queue + Claim-Released Signal + Auto-Retry)

## Purpose

Ticket B must not hard-fail on `FILE_CLAIM_CONFLICT` when ticket A holds the same path. Today the only behavior is: `backend/src/modules/supervisor/ticket-change-ledger.js` throws `FILE_CLAIM_CONFLICT`, the run ends `REPORT_FAILED`, and a human re-runs B manually after A releases. Evidence of the manual path: `LOG-a6df93eb-6437-46aa-b49a-911165dc04c4` (B's conflict event) and `ARTIFACT-ff9d2ce5-770e-4157-a9fa-d4645acdd27f` (B's resume checkpoint → `report_done` after A released).

This plan adds automatic same-file ticket queueing: B waits, is notified when A releases, and retries its RUN without human intervention. It is a separate, follow-up plan — it must land only after at least one ticket has completed a full dispatch → coder → review → approve cycle on the current pipeline.

## Scope boundary

- In scope: file-claim wait queue, claim-released signal between supervisors of the same project, automatic retry of a queued ticket's RUN, ordering/fairness rules.
- Out of scope: Reviewer tool access, cross-project messaging, `ReviewSupervisor`, a second queue/store/DAG. Coder occupancy (`plan-agent-occupancy-ticket-supervisor.md`) stays separate: that plan serializes on the Coder; this plan serializes on the file path.
- Constraint: work happens inside the existing Ticket Supervisor + Forge runtime. The wait queue persists in the same ledger/workspace store the claim already uses — no new datastore.

## Required behavior

```text
SV-B calls changeLedger.write(path) while SV-A owns the claim
→ instead of throwing FILE_CLAIM_CONFLICT to the run,
  ledger (or its caller) registers B in the per-path wait queue
  persisted next to claimPath
→ B's ticket transitions to FILE_CLAIM_WAITING (new non-terminal status),
  its RUN is suspended with a checkpoint
→ SV-A's terminal path calls ledger.release(path)
→ release publishes `file_claim_released` { path, released_task_id, released_at }
  on a project-scoped supervisor event bus
→ the head-of-queue waiter (B) is resumed: claim → retry RUN from checkpoint
→ B proceeds to report_done / review with its own claim
```

If the waiter's ticket is cancelled, the queue entry is removed and the next waiter is promoted. If the owner fails terminally, the release path must still emit `file_claim_released` so waiters are not stranded.

## Components

| Area | Required change | Acceptance evidence |
|---|---|---|
| Wait queue | Persist a FIFO per-path wait queue alongside `claimPath(path)` in `ticket-change-ledger.js`. Entries record `task_id`, `enqueued_at`, `checkpoint_id`. | Two waiters on one path are resumed in enqueue order; restart preserves order. |
| Claim-released signal | Emit `file_claim_released` from `ledger.release()` and from every terminal path that drops a claim (including `agent_failed_terminal`, `cancelled`, `deferred`). | Waiter resumes after an approved release AND after a terminal-failure release. |
| Supervisor event bus | Project-scoped pub/sub so any SV in the same project sees `file_claim_released`. Reuse `execution-event-bus.js` if it is already project-scoped; otherwise add a durable per-project channel, not in-process pub/sub (must survive SV restart). | Waiter in SV-B resumed even though release happened in SV-A, and even after an SV-B restart. |
| Waiting status | New ticket status `FILE_CLAIM_WAITING`; RUN suspends via checkpoint instead of ending `REPORT_FAILED`. UI/record shows waiting + owner task id. | B's run no longer ends `REPORT_FAILED`; record shows `FILE_CLAIM_WAITING` then resume. |
| Auto-retry | On `file_claim_released`, the head-of-queue waiter claims the path and retries its RUN from the suspended checkpoint. If claim still fails (foreign owner), stay queued. | After A's `report_done` + release, B reaches `report_done` with zero human action. |
| Timeout / starvation | Configurable `claim_wait_timeout_ms`; on expiry the ticket escalates (`needs_human_review`) and is dequeued. Bounded fairness: no waiter can be starved by repeated later arrivals. | Timeout produces `claim_wait_timeout` escalation, not an unbounded wait. |
| Failure handling | No silent catch: `transact` errors surface via logger; corrupt queue entry → `claim_queue_corrupt` failure, ticket escalates. | Corrupt entry test escalates cleanly without blocking other waiters. |

## Implementation focus

1. `ticket-change-ledger.js`: extend `write` conflict path — replace `throw failure("FILE_CLAIM_CONFLICT")` with `enqueueWaiter` + return `{ code: "FILE_CLAIM_WAITING", owner, position }` (caller converts to the new status). `release()` emits `file_claim_released`.
2. `production-runtime.js` / `nodeforge-task-executors.js`: translate `FILE_CLAIM_WAITING` into ticket status + suspend, subscribe for that ticket's path.
3. `durable-queue.js`: reuse `transact`/`claim`/`ack`/`recover` primitives for the per-path wait queue — do not build a parallel queue.
4. `execution-event-bus.js` (or a new `supervisor-message-channel.js` only if the existing bus is not project-scoped or not durable).
5. Checkpoint integration: `FILE_CLAIM_WAITING` suspends via existing checkpoint mechanics so restart resumes cleanly.

## Validation sequence

1. Two SVs, one project, tickets A and B both touch `backend/src/witness.js`. A claims first. B's write returns `FILE_CLAIM_WAITING`; B's ticket shows waiting, not failed.
2. A completes → `report_done` → `release` → `file_claim_released` → B auto-claims and resumes → `report_done`. No manual retry.
3. Three tickets on one path resume FIFO.
4. SV-B restarts while waiting; after restart B still resumes on the release signal.
5. A ends `agent_failed_terminal`; waiters still resume.
6. Timeout: cancel A's release artificially; B escalates at `claim_wait_timeout_ms` with `claim_wait_timeout`, not stuck.
7. Negative probes: foreign SV cannot dequeue B; waiter's claim attempt while foreign owner still holds the path keeps B queued (no steal).

## Definition of done

A same-file conflict on a file claimed by another ticket produces `FILE_CLAIM_WAITING`, not `REPORT_FAILED`; the waiter resumes automatically on `file_claim_released` in FIFO order, survives SV restart, escalates on timeout, and the manual retry demonstrated by `LOG-a6df93eb-…` / `ARTIFACT-ff9d2ce5-…` is no longer required.

## Open decision for owner

- Backoff policy on retry: immediate vs. short jittered delay.
- Whether `file_claim_released` also wakes cross-project waiters (out of scope by default; flag if needed).

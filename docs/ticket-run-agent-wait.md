# Initial RUN waiting for a Coder

The shared ticket RUN dispatcher retains authorized launch requests when an enabled Coder
is occupied by another execution. This covers fixed Coder contracts and tickets that can
use any available Coder. Disabled or missing profiles remain configuration errors.

The API returns `accepted`, `queued: true`, `reason: agent_wait_pending`, a `wait_id`, and
the occupying claim plus the next retry time. A project log explains that Node retries
every 30 seconds and that Stop pauses the wait. Waiting does not call SL or AM.

Requests are persisted in the `ticket.run-agent-wait` file queue. They retain the approved
Sprint revision, dependency expectations, ticket version and previous execution identity.
Each retry re-enters normal RUN validation. Queue locks, reservation tokens and execution
claims prevent duplicate launch. A replaced ticket or changed plan cannot silently reuse
the old RUN request. An unknown launch outcome is never replayed as an unstarted wait.

Stop cancels the durable wait while leaving the ticket resumable. Releasing a Coder after
Stop does not restart it. API shutdown stops its project-owned polling worker; persisted
waiting requests become eligible in the replacement API process.

Sprint DAG dispatch waits for the queued RUN's actual execution result before using its
execution ID to await completion. HTTP callers receive the queued response immediately.

Deployment requires restarting the Control API. Earlier failures that never created a
wait request are not inferred from error prose: RUN those tickets once with the updated
API to register their authorized request in the queue.

## Validation

The focused RUN/wait/recovery checks passed 33 tests, and scoped lint passed. Additional
checks exposed 10 existing failures in `ticket-dependency-submission.test.js`,
`ticket-execution-fencing.test.js`, and `coder-production-recovery.test.js`. Running those
cases with the RUN dispatcher and availability changes removed reproduced the same failures:
hard-review fixture setup, missing legacy failure events, and duplicate Stop failure events.
These results do not establish that the live API has loaded the new dispatcher.

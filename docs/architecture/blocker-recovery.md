<!-- Describes SL/Architecture ticket coordination without historical call quotas and the execution boundaries that still apply. -->
# Blocker recovery

SL/Architecture investigations and Coder resumes have no execution-wide count quotas.
`calls` and `resumes` remain audit counters, not dispatch gates. The retired
`NODEFORGE_BLOCKER_MAX_CALLS` / `NODEFORGE_BLOCKER_MAX_RESUMES`, constructor
`maxCalls` / `maxResumes`, and persisted `policy.max_calls` / `policy.max_resumes`
values no longer limit coordination, disposition correction or Coder resume.

After deployment, the worker re-arms legacy `triage_budget_exhausted` and
`disposition_correction_budget_exhausted` jobs at their retained role when their
execution remains valid and their deadline has not expired. This transition is
recorded as `call_limit_removed` in the existing history. It does not reset the
execution, source identity, previous responses, or audit counters.

Legacy `resume_budget_exhausted` jobs with retained resolved dispositions are
re-armed at their existing investigation role under the same execution/deadline
checks. `resume_limit_removed` retains the previous disposition in history.
The worker investigates again rather than blindly replaying a cached resolution
that may predate an unresolved technical prerequisite.

Owner Stop, cancellation, source/approval/dependency validation, file ownership,
and unknown-provider fencing still apply. The existing execution deadline
(`NODEFORGE_BLOCKER_DEADLINE_MS`, production default one hour) remains a separate control.
An expired or unknown-provider job is not automatically replayed by this change.

AM returns `reconciliation_required` with a summary and concrete guidance when a
technical prerequisite still prevents execution (for example, another ticket's
file claim or a missing integration handoff). Architectural agreement alone is
not `resolved`. This outcome parks the job without resuming Coder or publishing
an owner policy decision. SL routes the same outcome to AM first. The retained
stage can be explicitly resumed after the prerequisite is reconciled.

An existing evidence-bearing Owner cancellation releases the cancelled ticket's
abandoned file claims when its disposition is saved or read. Cleanup defers while
execution/occupancy, a launch claim, pending writes or a pending commit remain.
It uses the locked change ledger, closes the journal and preserves source bytes,
recorded changes and commit history; claims owned by other tickets are untouched.
This also repairs cancellations recorded before claim cleanup was wired in.
Cleanup scans the project's claim metadata, including orphan claims not listed
in the journal, even when the journal is closed or missing. Ticket and path locks
match the change ledger; execution and claim identity are rechecked before deletion.
Missing journals are not recreated, and malformed metadata fails closed.
Legacy claims containing only `task_id` and `path` remain valid ownership records;
an absent `claim_id` does not mean the file is unclaimed.

An explicit Owner-requested release of inactive, non-cancelled work uses the same
fences but leaves its journal open for resume. It does not cancel the ticket,
clear review findings, change status or discard uncommitted source.

Every SL/AM investigation receives fresh project-scoped `authority_context.file_claims`
for referenced paths. A null owner means the competing claim no longer exists,
not permission to skip approval, ticket scope or verification. Invalid claim
metadata and storage errors fail closed instead of masquerading as free ownership.

## Completion verification

`report_done` can start Node verification when its artifact is missing or stale.
It waits at most ten seconds in the recovery polling loop, then returns
`VERIFY_RECOVERY_PENDING` with `details.job_id` if the job is still running.
The job is not cancelled and no completion report is saved. Coder polls
`check_test` for that job and retries `report_done` after it passes, without
recommitting unchanged source or starting duplicate tests. Existing durable job
reuse and same-revision verification attempts remain unchanged.

This avoids a 120-second MCP timeout while valid verification is still running.
Coding activity shows pending verification as working, not a failed check, and
includes bounded error codes for genuine failures without exposing tool output.
Only a current passed artifact and complete AC coverage can admit the report.

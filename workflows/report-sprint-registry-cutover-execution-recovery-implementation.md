<!-- Records execution-recovery implementation progress, a failed focused check and the unverified corrective changes. -->
# Sprint Registry — Execution recovery implementation progress

Date: 2026-10-09 (UTC). **Verdict: governed fixture repaired; focused dependency-submission test passes. Partial R1 evidence, independent review pending; no full recovery/cutover acceptance or rollout.** R2–R6 and full O1–O7 acceptance are not completed.

## Latest fixture repair and focused pass — 2026-10-09

Repaired only `backend/tests/unit/ticket-dependency-submission.test.js` in this follow-up. The fixture now constructs real `createRuntimeToolGovernance({ database })` and `createForgeToolRegistry` scoped to its disposable root/File Service, and passes both to integration instead of a governance stub with missing registry. The fake provider asserts the Forge MCP server and `mcp__forge__read_file` allowlist before raising its intentional `PROVIDER_OBSERVED` marker. Existing stale-intent, queue/history, local/external/multiple-dependency and immutable-completion assertions were retained. Production source/gates were not changed by this fixture repair.

One narrow check: `node --test backend/tests/unit/ticket-dependency-submission.test.js`. Forge returned **passed**, exit **0**, ready_for_review **true**, run `VERIFY-RUN-156a73d0-ef09-4d62-ad6d-aa4c0749437d`, evaluated `2026-10-09T00:57:21.270Z`. Tested fixture SHA-256: `d27313d7f2cca8a0ce0deb9aaf0344dcbd47e7d5c94d14d3f1734874195642d1` (148 lines). No source/test edits followed this run; reports only. Eight scenario registrations are not claimed as raw TAP totals; totals/Node version/output hashes remain unavailable.

This establishes the focused fixture/provider-boundary witness, not actual agent execution, authorization of a tool invocation, a worker consuming queued jobs, durable admission/exactly-once, killed-process recovery or independent Reviewer acceptance. The earlier eight-file commands were not rerun after this fixture edit and remain historical failed checks; this one-file pass does not turn those whole commands into passes. The remaining admission/side-effect/event/compatibility and O1–O7 gates below remain open. Git inspection/commit outcome is recorded separately below.

## Historical authorized focused rerun — 2026-10-09

The owner explicitly authorized one additional focused check. Reran the same eight-file command recorded below, without code/test edits. Forge returned **failed**, exit **1**, ready_for_review **false**, run `VERIFY-RUN-948929d7-5921-409a-ab8d-9b34c0605685`, evaluated `2026-10-09T00:49:51.394Z`.

Valid-launch scenarios now reach `nodeforge-task-executors.js:20` and fail with `CONFIGURATION_ERROR: NodeForge integration requires governed Forge tools`, rather than the intended fake-provider marker `PROVIDER_OBSERVED`. The fixture at `ticket-dependency-submission.test.js:57` supplies runtimeGovernance and the fake Claude gateway but omits toolRegistry. The executor explicitly requires both toolRegistry and createExecutionContext before calling the provider. This identifies the current configuration failure, not a passing provider-launch or full R1 witness. Total TAP/pass/skip counts are unavailable; do not infer all other scenarios passed from the failure excerpt.

Checked helper SHA remains `e2a0a7fffaa5b6829aeb3247337b23b006d90b3f9d09b0ed1207e58c46c4e966`; checked test SHA remains `db1cbdcb274802298f126851e15920fc5193bb154fc0aa10667002d88697b0da`. Executor source read for diagnosis: `36ebcc8e5fb2d0d41747ff557990f8ce77a3cb4443e69ec023621dd95d5b385d`. No implementation or fixture was changed in this verification-only follow-up; reports only were updated. Fixture correction and subsequent verification remain required. No second check, full suite, commit, push or rollout was performed. This latest result supersedes the previous statement that corrected bytes had not been rerun, while preserving the historical failed run below.

## Inputs and authority

Read audit 0h in full (60 lines), the new execution-recovery plan in full (113 lines, including a bounded window for the omitted middle of the tool output), and section 0h of the current audit index. Individual Forge identities:

| Input | SHA-256 |
| --- | --- |
| `report-sprint-registry-cutover-follow-up-0h.md` | `b98e65a60abba5e60f5a2038691332c0e682f8e3ca9edcc38904d745e6770f72` |
| `plan-sprint-registry-cutover-execution-recovery.md` | `80cbcae0d1b81e5c4516a313c0f504cc058556e827f5c68557dc95196961eba2` |

The plan remains Draft; no runtime approval receipt was inferred from the owner's coding request. No production RUN, migration, approval, destructive cleanup or ignore-policy change was performed. No immutable approved bytes were edited.

## Code changes made

- The fenced DAG now returns a serializable dependency expectation set after revalidation and passes it to shared RUN. Each dependency carries Ticket ID, original completion execution ID/basis, and the newly captured scheduling basis. Scheduling version is captured after legitimate wait/lifecycle progression; completion identity is not replaced.
- Production DAG composition forwards the set instead of dropping it at the Ticket dispatch adapter.
- Shared RUN clones the input set at entry, validates exact dependency-set coverage and current plan/version/done execution, and rechecks after checkpoint/resume preparation before claiming and after sequential clears before submission.
- `beginExecution` stores `dependency_expectations` with the execution claim in the existing status details/history transaction. Phase writers preserve this evidence; a newly claimed execution explicitly replaces or omits old expectations. This is persisted intent, **not a durable queue admission receipt**.
- Approved dispatch preserves the set in `payload.dependency_expectations` and compares it with the durable target claim. A caller cannot silently reorder/substitute dependency evidence for an existing claim.
- Production runtime passes Registry into the existing NodeForge integration. With expectation-bearing payloads, integration checks original dependency and target execution/scheduling identity at entry, after workspace/context preparation, after occupancy selection before enqueue, and after enqueue before inline provider launch/review continuation.
- Undefined expectation sets retain an explicit compatibility branch; standalone/direct-code behavior is not silently changed. Complete entrypoint convergence remains R5 work.

## Test implementation

Added `backend/tests/unit/ticket-dependency-submission.test.js`, registering eight scenarios through real DAG/shared RUN/approved dispatch/integration components, disposable SQLite/immutable plans/status/history and actual durable/file-backed queue:

- Rebind during checkpoint load; block during workspace resolution; attempt replacement during occupancy selection; rebind inside actual queue save.
- Multiple external dependencies and combined local/external dependencies retaining exact identity in claim/history/queue and a second SQLite connection.
- Same-plan Sprint completion capturing its current scheduling version without replacing original completion identity.
- Omitted expectation entries and payload substitution rejected without refreshing old intent.

Provider, occupancy, workspace resolution and event publication are controlled doubles. The provider intentionally throws `PROVIDER_OBSERVED` when reached; there is no real agent execution, workspace integration, killed-process recovery or worker-launch proof. Scenarios are source registrations, **not passing witnesses**.

## Verification — failed, followed by correction

The one requested check call ran:

```text
node --test backend/tests/unit/ticket-dependency-submission.test.js backend/tests/unit/sprint-dependency-revalidation.test.js backend/tests/unit/ticket-execution-fencing.test.js backend/tests/unit/ticket-run-dispatch.test.js backend/tests/unit/ticket-status-store.test.js backend/tests/unit/sprint-run-basis.test.js backend/tests/unit/supervisor-execution.test.js backend/tests/unit/direct-code-supervisor.test.js
```

Forge returned **failed**, exit **1**, ready_for_review **false**, run `VERIFY-RUN-4d1e8627-90c7-4604-94dc-1e282c0e398d`, evaluated `2026-10-09T00:41:19.005Z`. New submission cases rejected valid dependencies before their nominated pauses; four boundary cases consequently timed out, and valid-launch assertions received reconciliation conflicts rather than the provider marker. No overall pass, independently verified result or TAP totals are claimed.

Cause found in source: the new synchronous guard assumed scheduling `Registry.get()` included `ticket_ids`. It does not; those IDs are exposed by asynchronous detail projection. The guard therefore rejected every valid dependency. Removed that invalid projection-field check after the failed run; immutable membership resolution remains the existing DAG/approval path, not a fabricated field on scheduling records. Also changed pause tests to race early submission failure against reaching the boundary, preventing that early failure from being hidden by a timeout.

**These corrections were not rerun**, respecting the owner's one-check-call instruction. Tested helper SHA was `bc12431be381aad397c12bdd0362dfa3036e6898eb5bb923cbac4166e39e4b0e`; tested test-file SHA was `a9d136cbadac794840cdc859717b8d7303a9cb4489efaa49d0a9f304fbad81d7`. Final identities below differ; the failed run is not evidence that corrected bytes pass. A focused rerun is required before review/commit/rollout.

No full suite, browser/UI interaction, lint/build/typecheck, production startup, load, migration/restore/rollback or crash drill ran. Exact Node version, raw output hashes and total pass/fail/skip counts were not supplied by Forge.

## Historical source identities before governed fixture repair

The test-file identity in this table predates the latest fixture repair; use the tested SHA in the latest focused-pass section for current fixture bytes.

These are individual edit/read identities, not an atomic repository snapshot. All changed files remain within 250 lines; production-runtime remains 248 lines.

| Changed code/test | SHA-256 |
| --- | --- |
| `backend/scripts/start-control-api.mjs` | `3649a0921032172711ebc3783bcdd46b312bac21a5c5382cbb66aa77974ead27` |
| `backend/src/application/ticket-run-dispatch.js` | `6cb4f5490bdaf838ea4424bd781a10bbf6716defa308f64a10134f1935324eed` |
| `backend/src/application/approved-ticket-dispatch.js` | `6913fb86a5977911fe650d00c5daf4450c8654edd8891bf5630b89023c667040` |
| `backend/src/modules/projects/ticket-status-store.js` | `ac55b41d68bfd0faa82cf9154189e5dd6d2dabacdcdc5d7936d3b56c11253dca` |
| `backend/src/modules/projects/ticket-execution-identity.js` | `fb354e8cc417b47bef6c4c286b05c25ce0c8ebc08162e69290fd1782fc81825d` |
| `backend/src/modules/supervisor/sprint-execution-wait.js` | `87504759fb1b775815387803806754382bf192ee8509f489337d38e211e30eb1` |
| `backend/src/modules/supervisor/nodeforge-task-integration.js` | `83bab4da8cecff7cd6099ad9526a2fa2006c9b9cdc98aba09b40366a3c44486b` |
| `backend/src/modules/supervisor/production-runtime.js` | `50046f8dab6ac5097c26a8fa97c0f8991e53bda21f9fa9de97f0cfda38e2797a` |
| `backend/src/modules/supervisor/ticket-dependency-expectations.js` | `e2a0a7fffaa5b6829aeb3247337b23b006d90b3f9d09b0ed1207e58c46c4e966` |
| `backend/tests/unit/ticket-dependency-submission.test.js` | `db1cbdcb274802298f126851e15920fc5193bb154fc0aa10667002d88697b0da` |

## Remaining work / decisions

- R1 remains partial: the repaired one-file focused test now passes through actual submission components with a file-backed queue and fake provider. Complete durable-admission, restart/continuation and cross-process proof, plus independent Reviewer verdict, remain missing. Earlier failed commands retain their historical results.
- R2 remains open. Checks and persisted claim evidence do not serialize Registry/status/filesystem queue/occupancy/provider launch across processes. If invalidation occurs inside queue save, a queued job may already exist before inline launch is rejected; no orphan disposition, durable committed receipt, launch owner or no-auto-redispatch guarantee was implemented. A queue worker could consume that job; no safety claim is made for that path.
- Before implementing admission commit/stop semantics, Architecture/human must settle the plan's explicit decision: mutation before commit rejects intent; after commit, determine cancellation/fencing obligations and who owns launch/recovery. The existing inline execution plus file queue coexistence needs an actual consumer inventory, not an assumption that one owns execution.
- R3 event append/application/projection repair, waiter invalidation without terminal delivery, reconnect/restart and listener cancellation remain open; no arbitrary timeout policy was introduced.
- R4 partial clear/review/integration/ledger recovery remains open; extra guards do not make already-performed preparation all-or-nothing or archived.
- R5/R6 full producer/status-writer/compatibility inventory, source-bound independent Reviewer evidence, exact approval and SL forecast remain open. No dates or acceptance verdict were invented.
- Carry-forward authority/UI/handoff/historical migration/backup–restore–rollback and human O7 gates remain unchanged. No legacy store/schema was retired or dropped.

## Historical Git handoff before fixture repair

Forge `git_status` and `git_diff` were read. Status reported exactly the ten code/test paths in this batch: 8 modified, 2 untracked, 0 staged, 0 conflicts. Reports under ignored workflows are not listed by Git status. Diff output was truncated; it is not a complete staged/untracked snapshot. Source identities above remain the individual evidence references.

No commit/push was attempted because verification failed and corrected bytes remain unverified; no Git SHA is claimed from the verification commit_id. Earlier ignored-workflows staging failures are historical, not a new attempted-commit result for this batch. Section 0h received a clearly labelled Coder progress note pointing here, without changing Architecture/Reviewer acceptance; the audit stays at 250 lines.

## Latest Git handoff after governed fixture PASS

Forge `git_status` and `git_diff` were inspected before committing. Status showed the same ten pending implementation/test paths (8 modified, 2 untracked, 0 staged, 0 conflicts); this follow-up edits only the fixture among those paths. Reports under ignored workflows are not represented in status. Diff output was truncated, so it is not a complete diff artifact; individual source identities and the focused checked fixture hash remain the evidence references.

`commit_changes` with message `test(sprints): configure governed dependency submission fixture` failed with **GIT_ADD_FAILED** because workflows paths are ignored. No commit SHA was returned, so **no push** was attempted. Source/test/report edits remain in the working tree; the failed staging attempt may have staged permitted code paths before rejecting ignored reports. No force-add or ignore-policy change was performed. A human decision on ignored-artifact staging remained necessary at that handoff; the verification commit_id is not a Git SHA. The owner subsequently directed that workflows documents remain internal and be excluded from staging; see `workflows/report-owner-commit-internal-workflows.md` for implementation and the unresolved runtime activation issue.

## Latest implementation follow-up — audit F5, recovery and cached verdict evidence

Date: 2026-10-09 UTC. This is Coder progress, not independent acceptance. The implementation plan remains `workflows/plan-sprint-registry-cutover-execution-recovery.md` (revision 1, file SHA `80cbcae0d1b81e5c4516a313c0f504cc058556e827f5c68557dc95196961eba2`). The input audit is `workflows/report-sprint-registry-cutover-execution-recovery-audit.md` (SHA `431b2bc369dc80af9fd540951e5544a57323c20d61329ffedb772c4ea61dfae1`); it is not a new plan or RUN receipt. No approved plan bytes or audit verdicts were edited.

### Actual code changes

- `production-runtime.js`: persist the actual verification result and its original request basis before publishing its event. Recovery no longer manufactures `verification.passed` merely because a verification job exists.
- New `recovery-evidence.js`: select evidence by Supervisor/task/correlation/attempt and supplied Project/job identity rather than the last task-only job. Ambiguous, incomplete, failed, missing or unbound successful results remain blocked with reconciliation diagnostics; no replacement RUN is launched by this helper.
- Recovered Registry-owned evidence must match the current exact execution and immutable basis. Cached review outcomes must match their original request/source snapshot. Worktree-backed recovery revalidates the committed verification/review evidence through existing services.
- `review-request-handler.js`: preserve findings persistence; check ownership before writes, bind persisted verdicts to their original request/source basis, and validate cached evidence before checkpoint/publication/acknowledgement. A detected replacement execution is a non-retryable reconciliation conflict, not a failed verdict applied to the new attempt.
- New `supervisor-recovery-evidence.test.js`: file-backed production restart and verification producer witnesses, plus negative cached-review and ownership-boundary tests. Provider results and ownership are controlled doubles where stated; these are not independent Reviewer verdicts or multi-process crash tests.

### Verification — FAILED, then corrections not rerun

One focused check was run:

```text
node --test backend/tests/unit/supervisor-recovery-evidence.test.js backend/tests/unit/supervisor-execution.test.js backend/tests/unit/review-request-handler.test.js backend/tests/unit/ticket-dependency-submission.test.js backend/tests/unit/owner-engineer-tools.test.js
```

Run: `VERIFY-RUN-08ef54e4-e8e7-4837-af38-032246d8b46c`, evaluated `2026-10-09T01:33:57.878Z`; status FAILED, exit 1, ready_for_review false. Returned failure records identify two failures in the new test file:

1. Successful recovery remained REVIEWING because JSON persistence removes undefined fields while the in-memory request-basis comparison retained them. Corrected the basis to its JSON storage representation and added a round-trip regression witness.
2. The producer test called a non-public `processOnce` method. Corrected it to start the actual verification worker and observe completion through a bounded test-only polling window; no production timeout or waiter policy was introduced.

At the end of that implementation turn, the corrections had NOT been rerun because the single-check allowance was consumed. That historical verification state is superseded by the explicitly authorized rerun below; the original failed run remains FAILED.

### Authorized focused rerun — PASS

The owner authorized rerunning the exact five-file command above. One `run_check` call was made, with no full-suite, build, lint or typecheck invocation.

- Run ID: `VERIFY-RUN-a64183c1-595f-4ecd-9566-871871cffe5b`.
- Evaluated: `2026-10-09T01:40:43.694Z`.
- Result: PASSED; test command exit code 0; service `ready_for_review: true`.
- Scope: supervisor recovery evidence, supervisor execution, review-request handler, dependency submission, and owner engineer tools tests named in the recorded command.
- Post-check Forge reads confirmed the four individual source/test hashes in the table below still match the corrected implementation. No source/test edits were made during this verification turn. These reads are not an atomic run-time source manifest.
- Raw TAP totals, Node version and complete stdout artifact/hash were not supplied in the tool result. No test counts are inferred. The tool's broader `changed_paths` ledger is not a statement that all those paths were tested.
- PASS is Coder/service verification, not independent Reviewer acceptance. R1–R6 and carry-forward O1–O7 retain the open items below; earlier failed commands are not relabelled PASS.
- This turn performed verification and the standing internal-report update only: no live RUN, migration, rollout, commit/push or legacy retirement. Internal workflows documents remain local, outside staging.

### Current individual source identities after correction

| File | SHA-256 |
| --- | --- |
| `backend/src/modules/supervisor/production-runtime.js` | `c2802839e2da1a6468d94f060be7c5cca611ad8c5a1b9bcb1dbc5bf42e89bf90` |
| `backend/src/modules/supervisor/review-request-handler.js` | `a3080a3b52213445ecadcd2475acd407f71a61d7c27b118d2eb84ad12026b869` |
| `backend/src/modules/supervisor/recovery-evidence.js` | `7c07aa0565e052a3d79323a5b4b400e1fd5e6f0a09e76c9e617000d6691ace46` |
| `backend/tests/unit/supervisor-recovery-evidence.test.js` | `1e61f85e316be11ba4f5170e08b8ca15b052ff69f74f790989d3d926070ab0c9` |

These are per-file identities, not an atomic tested snapshot. New helper and test files are below 250 lines; production runtime was reduced to 243 lines (Forge whole-file line count) by extracting recovery logic. No schema/store was dropped or retired.

### Outcome ledger at the F5 follow-up boundary

The R1/R2 statements below describe the F5 batch, not the later launch-ownership increment linked at the end of this report.

- R1/R2: dependency intent progress remains partial; durable admission, queue orphan disposition, committed launch owner and cross-process commit/stop ordering are NOT implemented by this follow-up. Architecture/human decisions explicitly identified in the plan remain required for semantics-changing admission work; this does not block the independent corrections above.
- R3: this fixes one recovery producer's evidence selection, not durable event consumer progress, missed fanout/projection repair, waiter liveness or reconnect/restart acceptance.
- R4: added review ownership guards do not serialize cross-process writes and do not provide archived/atomic clear, findings, checkpoint, integration or ledger recovery. In particular the independent `reviewOnly` integration path remains a finding.
- R5: a portion of cached review/recovery producer handling is implemented; full compatibility/consumer inventory, execution identity propagation and historical unbound evidence disposition remain open. Legacy standalone review compatibility is retained; no old evidence is silently upgraded to a new execution/source snapshot.
- R6: no Coder dispatch, live RUN, approval mutation, independent Reviewer acceptance, staffing estimates or full forecast was performed. R1–R6 and carry-forward O1–O7 are not closed by this batch.

### Git and internal documents

Forge status/diff were inspected after the corrections. Status reports 15 changed paths: 12 staged from earlier work, 2 unstaged tracked changes, 2 untracked new files (production-runtime overlaps staged/unstaged). Those prior changes were preserved. The diff is unstaged and truncated, not a complete staged/untracked source artifact. No commit/push was attempted because the focused batch failed and the corrected bytes remain unverified. The previous ignored-workflows runtime blocker was not retried here; internal documents remain local, without force-add or ignore-policy changes. No migration, rollout, legacy retirement or live execution was performed.

## Latest R1/R2 increment — durable launch ownership and handoff disposition

See `workflows/report-sprint-registry-cutover-launch-ownership.md` for the repository consumer inventory, original-intent launch record, retained dead-letter reconciliation disposition, source identities and scoped independent Reviewer handoff. The existing R1–R6 plan is unchanged; this is not a new plan or RUN authority.

The six-file focused command in that report PASSED, exit 0, `ready_for_review: true`, run `VERIFY-RUN-fd618858-3a1b-4dcf-b26e-79d577c1fce1`, evaluated `2026-10-09T02:04:48.388Z`. Witnesses include two actual processes competing for one launch record and the handled queue-save invalidation path retaining a non-dispatchable job. This supersedes the lack of remediation for those specific paths, not the full crash/admission/consumer inventory or independent acceptance gates. R1–R6 and O1–O7 remain partially/open as scoped in the linked report.

Previous follow-up: section 8 of that report records the conservative unreconciled-launch replacement gate, intent-versus-dispatch-boundary events, launch-ownership Reviewer criteria/source identities, and five-file focused PASS `VERIFY-RUN-8780b00e-b184-45b1-8ee4-639435051a68` (exit 0, evaluated `2026-10-09T02:26:09.256Z`). Its failure-handler rejection describes that historical batch only, not the latest state.

Latest follow-up: section 9 records explicit owner authorization and implementation of the exact unknown-provider-outcome failure handling: retain occupancy after a launch claim, skip generic failed-outcome handling, return scoped non-retryable reconciliation with the original cause, and preserve quarantined job evidence. Five-file check `VERIFY-RUN-e8d1e15b-fc48-4bef-bff6-18da623528a9` FAILED, exit 1, evaluated `2026-10-09T02:36:06.071Z`, with a returned diagnostic showing nested Error-versus-object assertion mismatch. Assertions were corrected afterward and have now been rerun in the owner-requested confirmation turn. The same five-file focused command PASSED, exit 0, `ready_for_review: true`, run `VERIFY-RUN-5eb080b2-bb76-4f03-a5cd-36e66d63efa3`, evaluated `2026-10-09T02:42:40.531Z`. Section 9 of the linked report records the exact command, individual source reads matching corrected identities, verification limits and Reviewer criteria. The historical FAILED result is preserved; this PASS closes only the pending focused-rerun item, not independent review, complete unknown-outcome safety or full R1–R6 acceptance. No source/test change, commit/push, production RUN or rollout was performed in the confirmation turn.

## Latest evidence increment: persistent occupancy and lease compatibility

Section 7 of `workflows/report-sprint-registry-cutover-launch-recovery.md` records fresh-process recovery against actual SQLite Agent Occupancy/Profile stores (four retained-launch checkpoint/terminal cases and two no-retained-launch controls), plus file-backed uncaptured/expired/unexpired handoff compatibility witnesses. Production source and the passed failure handler were not changed in this evidence increment.

Six-file focused check `VERIFY-RUN-0e051c14-445b-4b77-9fb6-4ef2d366dcfb`, evaluated `2026-10-09T03:38:09.831Z`, FAILED, exit 1, `ready_for_review: false`, naming one fixture incorrectly expecting a ticket failure event from direct-code. It was corrected to separate Registry missing-intent rejection, direct-code suppression and unregistered legacy failure publication. That final fixture correction has now been confirmed: the same six-file focused command PASSED, exit 0, `ready_for_review: true`, run `VERIFY-RUN-aa17d26f-770c-462e-b753-2289621e8eb7`, evaluated `2026-10-09T03:48:25.185Z`. Section 8 of the linked report records fixture identity read before the check and confirmation scope. No source/test changed in the confirmation turn; historical FAILED runs remain unchanged. The report records child Node/source/occupancy instrumentation and the service's raw-output limitation. The pending rerun item is complete, but no independent acceptance, full recovery or automatic availability repair is claimed. No production RUN, commit/push, migration or rollout occurred.

## Previous unknown-outcome recovery and Registry coverage increment

See `workflows/report-sprint-registry-cutover-launch-recovery.md` for retained-launch gates before recovery release/resume, individual authoritative RUN dependency capture, missing-intent/claimed-review-resume rejection, restart/negative witnesses and in-run source SHA-256 assertions including current durable queue source. The previously approved failure catch and queue implementation were not rewritten.

Eight-file focused check `VERIFY-RUN-a88f48ed-3fb2-4af7-b4e3-fca991a6af26` FAILED, exit 1, `ready_for_review: false`, evaluated `2026-10-09T03:14:53.375Z`. Two older execution-fencing fixtures were corrected afterward; those bytes were subsequently included in the six-file evidence run described below. The report binds declared source identities to hooks in this command, not to an earlier PASS, and records remaining bypass/atomic-write/availability limits. No independent verdict or full recovery acceptance is claimed. Historical runs retain their results; no production RUN, Git mutation, migration or rollout was performed.

## Next R1/R2 increment: real dispatch crash and orphan evidence

`workflows/report-sprint-registry-cutover-dispatch-recovery.md` records captured-inline handoff queue exclusion/reconciliation, real dispatch SIGKILL/restart at execution-claim, queue-save, launch-claim and provider-response-loss boundaries, concurrent shared RUN processes, and quarantine-write failure. Production change is confined to `durable-queue.js`; the previous passed failure handler remains unchanged.

The seven-file focused command in that report PASSED, exit 0, `ready_for_review: true`, run `VERIFY-RUN-18c507ed-9f0e-49c1-9008-73b4ab8cc0f3`, evaluated `2026-10-09T02:59:14.136Z`. It includes the new process tests plus existing launch, dependency, execution-fencing, dispatch, failure and supervisor/queue tests. See the report for source identities, fixture limitations, R5 inventory delta and pending independent Reviewer handoff. Full R1/R2 admission/continuation and execution-only orphan repair, R5 consumer convergence, R4 write-time fencing, R3 waiter/projection repair, R6 acceptance/forecast and safe retained-claim disposition are not closed. No new plan, Git mutation, production RUN, migration, legacy retirement or rollout was introduced.

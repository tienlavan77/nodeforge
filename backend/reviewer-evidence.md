<!-- Explains existing Reviewer tools and retained commit evidence for ticket acceptance review. -->
# Reviewer source and diff evidence

Reviewer uses the same read-only tools across Codex/OpenAI and Claude/Anthropic: `search_tree`, `list_files`, `search_text`, `read_file`, `read_lines`, and `git_status`/`git_diff` when the workspace Git Service is available. No separate review-specific source or diff tool is registered.

Reviewer can read related source, repository instructions such as `AGENTS.md`, and contracts throughout its project. The latest changed-file delta is not a read permission boundary. `search_text` reuses the existing content search implementation with top-level directory inputs. Protected paths and symlink traversal remain blocked, including when a source cache is available. Searches are discovery, not verified provenance: the index and discovered filenames may be newer than the review commit.

Git tools receive only approved manifest paths. They retain their existing working-tree semantics; `git_diff` is not the verified base-to-review-commit patch. Use the fixed-revision patch in the prompt for that evidence. Commit, push, reset and other write operations are not exposed to Reviewer.

Post-integration review supplies the retained commit through the existing File Service interface. The existing source-window tool reads those committed bytes rather than the mutable working tree. Node includes the fixed baseline-to-review-commit patch in the review prompt; this is internal evidence preparation, not a new agent tool.

Project-root confinement, role restrictions, source-window limits, output budgets and metadata-only audit logging remain enforced. No shell, write or test-execution permission is added.

Manifest reads must match the verification artifact checksum and receive artifact-bound `review_evidence`. Nonmanifest reads do not receive that verified provenance. Verdict evidence references remain bound to the supplied manifest paths or current verification artifact.

Review findings still require actionable acceptance criteria and real evidence. `per_file_necessity` entries use `path` and `role`, not `file`. Reading source does not itself prove semantic retrieval isolation; the Reviewer must inspect the relevant behavior and verification evidence.

## Invalid verdict recovery

`REVIEW_VERDICT_INVALID` reports the specific finding field, for example `findings[1].per_file_necessity[0].path`, instead of misclassifying a structured finding as legacy prose. The validator does not rewrite `file` into `path`, infer evidence or approve malformed output.

A format failure remains `review.failed`, not an accepted request for Coder changes. For post-completion review (`review_gate: off`), terminal Coder completion is independent of Reviewer approval. Do not reset the ticket to pending or fabricate approval.

Use the existing automatic-review service's `retry(job)`, then `dispatch(retriedJob)` for an explicit Reviewer-only operational retry of the same logical job. The service retains attempt history and the same evidence identity, subject to its existing retry and ownership checks. A valid post-completion `request_changes` creates separate follow-up backlog entries; it does not reopen the completed Coder ticket. Re-delivery or recovery alone replays the recorded failure, not a new model invocation. This is an internal service operation, not a new SDK tool or public HTTP endpoint.

## Project-wide read verification (2026-10-19)

ROUTING-02's artifact contained 14 manifest files while its final verification delta named only two integration tests. The previous tool context incorrectly limited reads to those test directories, rejecting the router and `AGENTS.md`. Project-wide read discovery now uses role/path validation rather than the delta, and Git reads remain scoped to the manifest. Manifest source still requires its exact artifact checksum; contextual reads do not acquire artifact provenance.

A read-only replay against retained commit `3ea1526be887feeccea24320ff85f0d91406ca54` successfully read all 14 manifest files with artifact binding, plus the router through `read_file` and root `AGENTS.md`. No reviewer model was launched or runtime finding changed. Reload the Control API before a new review uses the updated policy; the separate session-verification finding remains outstanding.

Verification: 31 focused tests PASS, covering provider parity, reads beyond the delta, project instructions/contracts, discovery, committed evidence, protected paths, symlinks, cache checks and source drift. Changed source/tests ESLint and diff checks PASS. Legacy test fixtures were aligned with canonical `read_lines` and the independent review-only workspace rather than the removed inline Supervisor reviewer; committed-diff coverage now selects a baseline where its source actually changed.

## Review gate and repair lifecycle (2026-10-19)

Tickets without an explicit `execution_policy.review_gate` now default to `on`, including schema and Supervisor preflight. The existing immutable policy cannot change during an execution. Explicit historical `off` remains post-completion review; it is not silently rewritten.

The blocking lifecycle is `running → reviewing → running (Coder repairs findings) → reviewing → done`, with completion after independent approval and integration. Node projects `reviewing` before invoking Reviewer, switches back to `running` before repair and passes the entire structured finding to Coder. Real scope/blocker decisions and the existing repair limit still apply.

A parked review can Resume under its original execution and dependency basis. Active review has no enabled RUN on the ticket card. Backend also rejects duplicate review dispatch while a matching provider attempt remains active or unreconciled. Dashboard checkpoint projections distinguish active review from failed/resumable review; completed Coder work is retained.

Owner requested another review of legacy-completed `TICKET-NF-MPA-ROUTING-02`. A separate independent Codex review ran against retained commit `3ea1526be887feeccea24320ff85f0d91406ca54` and artifact `ARTIFACT-e63e580f-bd25-4734-9351-33b43914abfb`, with all 14 manifest files supplied. It completed in approximately 179 seconds with `request_changes` and two actionable findings: SSE project selection, and unprefixed legacy project endpoints still using default-application services. Router/source reads succeeded. Some overly broad discovery/window calls were rejected; the Reviewer narrowed subsequent calls successfully. Temporary provider 503 retries recovered within the same SDK turn.

Receipt and separate Reviewer checkpoint: `.forge/runtime/review-reruns/TICKET-NF-MPA-ROUTING-02/2026-10-19T08-29-55-724Z/receipt.json`. The previous review result, ticket completion and immutable policy remain historical; this rerun did not launch Coder, integrate changes or create acceptance. These two findings still require repair and another review.

Verification: 58 focused tests PASS across automatic review, repair, recovery, execution ownership, structured findings, manual review, checkpoint API projections and rendered ticket controls. Scoped backend modules/tests ESLint PASS. The API bootstrap retains three pre-existing unused-variable lint errors (`fileService`, `protocolStorage`, `conversationStateStore`); the UI file has two pre-existing ESLint issues (`TicketModal`/`englishContent` unused under the root lint configuration); rendered review-control tests PASS. Control API reload is required for the running service to use the new lifecycle; the explicit rerun above loaded current source directly.

## Owner reopened legacy review (2026-10-19 08:44 UTC)

On explicit Owner instruction, `TICKET-NF-MPA-LIFECYCLE-01` and `TICKET-NF-MPA-ROUTING-02` moved from `done` to `reviewing` with version checks and appended status history. Their execution IDs, integrated commits, terminal Coder contexts and Coder turns (67 and 127) were preserved. Both API ticket reads report `reviewing`; Sprint checkpoint projections report `resumable: true`, `phase: review`, `active_stage: reviewer`.

Backup and receipt: `.forge/runtime/review-reopen/2026-10-19T08-44-39-044Z/`. The receipt includes a consistent SQLite backup and per-ticket original rows, checkpoints and source bindings. No agent was launched. ROUTING's latest independent finding details are retained in its review checkpoint.

The first reopening implementation resumed the retained independent Reviewer through RUN, avoiding terminal Coder preparation. That initial implementation did not reopen Coder's terminal context or automatically launch a new Coder repair; the finding-driven repair below supersedes that limitation. Request changes remain reviewing with persisted findings; independent approval can restore done. Old automatic completion intents are suppressed for this explicit reopening so restart recovery cannot silently undo it. Existing dependency checks remain: review LIFECYCLE first, then ROUTING. Reload Control API before using this new resume branch.

Verification: 27 focused tests PASS for legacy review reopening, original execution preservation, duplicate/source protection, completion replay suppression, review source tools, status store and rendered review controls. Scoped backend lint and diff checks PASS.


## Finding-driven repair of integrated tickets (2026-10-19)

Owner-authorized legacy review now consumes a persisted `request_changes` directly: Node archives the original terminal context, closed ledger and integration receipt, prepares a fresh repair journal, and dispatches Coder with the complete unresolved findings and retained turn history. Historical files are not reclaimed or included in the new commit. Immutable ticket/plan approvals and original review policy are unchanged; the new repair cycle requires blocking independent review before completion.

Repair provenance reads the archived ticket journals separately from the new commit manifest. When a contract dependency changed in a later integrated ticket, exact live bytes may be traced to that same project's reachable completed integration and matching terminal context/artifact/source identity. Unbound working-tree changes remain conflicts; original approved checksums remain historical authority. Repair markers survive status events, and subsequent RUN resumes the retained repair execution rather than replaying the old review.

Verification: 71 focused tests PASS across repair preparation/crash recovery, contract and integrated-source provenance, retained execution resume, automatic review/recovery and ticket RUN. Scoped ESLint and diff checks PASS. All touched code/test files remain at or below 250 lines.

Runtime: the first Resume reached preflight but rejected `project-lifecycle.js`, which was already integrated by ROUTING at `3ea1526be887feeccea24320ff85f0d91406ca54`. Read-only verification with the corrected services proves that exact dependency source. A subsequent invocation launched Coder Siêu code with the retained semantic-isolation finding, resumed from turn 67 and reached turn 74 with successful Forge reads. It was explicitly stopped before writes because the API had restarted 11 seconds before the final repair-resume edit and therefore still dropped the cycle marker. The checkpoint and binding were reconciled under status-store validation; it is parked failed and resumable at turn 74 pending the final API reload. After the final API reload, RUN resumed from turn 74 in the same SDK thread (`01a1536d-2bb6-7463-869a-d451987e038c`) and advanced to turn 75. The persisted status remains running, its repair marker survives launch, and `sender.handoff` carries the exact `review_cycle_id` into the blocking review pipeline. The Coder occupancy claim is active for Siêu code (`885b2b5f-5247-4dfc-8f05-968de25391dc`). No repair completion or production acceptance is claimed.

Backup and reconciliation receipts: `.forge/runtime/review-repair-recovery/2026-10-19T09-09-50Z/`. Original review-reopen evidence remains retained. No commit/push was performed.

## Checkpoint polling after Stop and Resume (2026-10-19)

Fixed the operational recovery cancellation tombstone: an explicit checkpoint Resume can re-enable future transient retries for that execution. It does not resurrect cancelled child requests, reset consumed retry counts/deadlines, or reclaim unknown provider invocations. A nontransient blocker/verification failure is forwarded to its own handler even if a stopped recovery ledger exists.

RUN now recognizes a parked `CODER_BLOCKED` checkpoint with the exact approval-service 503 diagnostic and schedules a 30-second checkpoint retry after revalidating its immutable plan, dependency intent, execution and current source context. This is explicit RUN recovery; substantive policy rejection and any existing blocker disposition retain their separate boundaries. The latest Coder turn, session, file changes, commit and repair-cycle binding remain in the queued resume. Stop cancels the waiting retry. Terminal logging states the delay and Stop option.

Verification: 49 focused tests PASS across operational retry, production Coder wrapper, 503 blocker recovery, ticket RUN and retained review execution; scoped ESLint and diff checks PASS. Infrastructure fixtures declare their historical soft-review policy explicitly so they exercise infrastructure recovery rather than fail the newly enabled independent-review preflight. Runtime polling was subsequently observed: the queued 30-second retry dispatched Coder at 10:19:15 UTC in the same execution and repair cycle, advancing turn 93 to 94. Coder then parked on a separate verification/tooling fault; Reviewer did not rerun. The failed CLI verification due to the untracked `ticket-cancelled-claims.js` dependency is unchanged and still needs separate resolution.


## Verification evidence and AM-to-SL recovery handoff (2026-10-19)

Fixed premature parking after an AM answer: an accepted reconciliation response queues a real SL invocation before SL decides whether evidence is external or delegates Coder preparation. Architecture answers, original denial receipts, execution identity and the Coder checkpoint remain retained. SL can still park a concrete unresolved prerequisite or unchanged findings; AM does not dispatch Coder.

Node now supplies source-bound verification job status, failed immutable command diagnostics and bounded focused-check receipts in ticket_progress.verification, including historical runner evidence for diagnosis only. Reads do not start verification, mutate approval, or mark criteria verified. Wrong project/source/artifact identities remain rejected, concurrent context changes return unavailable, and the snapshot refreshes for each investigation. Complete original VERIFY_RECOVERY_PENDING/READ_REPEATED receipts classify as technical recovery; actual denials and incomplete/unknown receipt sets keep their gates. Misclassifying a proven technical fault as execution admission returns correctable feedback instead of requesting nonexistent denial receipts.

Verification: 69 focused tests PASS across Architecture response, execution admission, waiting evidence, technical reconciliation, criterion progress, failure classification and verification recovery. Scoped ESLint and diff checks PASS. Read-only runtime probes located VERIFY-c100924a-96fc-4ad1-9c53-db3e69c62a78 and ARTIFACT-e7fb44c7-2af5-4454-be13-e1d300596cd4, confirmed 5/6 checks passing with missing ticket-cancelled-claims.js in the CLI archive, and supplied CHECK-32ffed8a-3003-45de-8d5a-6cfab49abf2d plus the passing focused-check receipt. The current original failure receipts classify as technical, without changing their historical ACCESS_REQUIRED label.

Activation requires one Control API reload and Resume of the retained SL stage; no live recovery completion, new commit, approval or production acceptance is claimed. The missing archived dependency remains a source-composition failure, separate from this dispatch/evidence fix.


## Duplicate verification waits rejected before parking (2026-10-19)

The live SL invocation finished at 10:48:14 UTC but requested two records already present in its Node progress snapshot. The previous patch supplied evidence but did not validate that a returned external wait contradicted that evidence. Node now rejects such a disposition with correctable verification_evidence_already_supplied feedback for every duplicate request together; the existing automatic correction worker calls SL again within the retained execution. It does not silently resolve the blocker, waive approval or restart Coder. Real unavailable evidence and upstream dependency integration remain distinct prerequisites.

The provider prompt now ends with concise current verification facts after all historical pending/error claims. A read-only source diagnostic reuses the root Git service to check missing-module paths against the exact verification commit, alongside current workspace presence/hash. Git archive remains immutable; dirty files are never injected to make an old commit pass.

Read-only reproduction with the actual SL disposition identifies both waiting_for/0 and waiting_for/1 as duplicate evidence. Git confirms backend/src/modules/supervisor/ticket-cancelled-claims.js absent from 9dac62cf47a13d752a8f6bfd3aac7084ad283704 while present in the workspace (sha256:678d37aac6cf83b7fe4d8c2a45c0fd2992f81e8f2e863c67ecd4fa9cded80825). SL receives this exact committed-source defect and can select authorized recovery or identify the required upstream integration instead of requesting terminal status again.

Verification: 86 focused tests PASS; final narrowed evidence/wait recheck 12/12 PASS after tightening identity and duplicate-source matching. Scoped ESLint and diff checks PASS. Tests cover stale external wait correction across restart before Coder dispatch, all-duplicate feedback, actual SDK prompt ordering, missing versus committed dependencies in real temporary Git repositories, unchanged Git status during inspection, and forbidden/outside path rejection. No API restart, runtime mutation, new commit, or completed ticket is claimed. Reload Control API once and Resume the retained SL stage to activate.


## Committed dependency source refresh (2026-10-19)

Committed the two missing cancellation-claim modules separately as `832a9c2928600cc1ea75db39fa74c152bf8308fd`. This preserves the Coder repair commit `9dac62cf47a13d752a8f6bfd3aac7084ad283704`, unrelated worktree changes and the existing Git index. Cancellation-claim focused checks: 11/11 PASS. Static relative-import inspection from committed Control API startup checked 375 modules without a missing import.

The common root-ticket verification service now recognizes an independently committed dependency-only descendant after failed missing-module checks. Under the project commit lock, Node validates ancestry, added-file import closure, unchanged ticket bytes, source identity and context version, persists an immutable source-refresh receipt, and selects the new tree for fresh verification and independent review. The original ticket commit remains the source of changed_paths and ticket checks; dependency additions are not attributed to the Coder. Uncommitted dependencies, unrelated additions, existing-file modifications and incomplete import closure cannot be selected automatically. New Coder writes clear the refreshed-source binding. Repeating the original commit tool preserves the selected verification source and its passed artifact. No approval or acceptance is manufactured.

Verification: dependency/source/policy/recovery suites 33/33 PASS; report/completion/handoff suites 26/26 PASS (some wait tests overlap). Scoped ESLint PASS. Real temporary Git fixtures exercise automatic refresh after service restart, independent review source binding, preserved dirty files/index, repeated commit tool receipts, stale-source rejection and fresh-commit requirements after new edits.

Runtime source selection succeeded for LIFECYCLE-01 without resetting Coder turn 94. Receipt: `.forge/runtime/ticket-verification/TICKET-NF-MPA-LIFECYCLE-01/source-refresh/3c1e06a6da9d888d6800510b33cdb705f10bd9dcab35ebe5d1265541aef646e9.json`. Pre-transition context backup: `.forge/runtime/ticket-verification/TICKET-NF-MPA-LIFECYCLE-01/operator-backup-1792408233507/context.json`. Fresh verification job `VERIFY-67098262-3825-4d75-85c7-fa72b987b7f4` is running. This record does not claim completed verification, review or ticket acceptance. The serving API needs reload before normal resumed execution uses the new source-refresh behavior.


## Live verification and retained review-cycle recovery (2026-10-19 11:18 UTC)

The first standalone verification of 832a9c2 exposed an operator-runner environment omission: the CLI startup fixture could not find NODE_SECRET_ENCRYPTION_KEY. Loading the same deployment environment loader used by Control API fixed the operator environment; no production key was printed or test result rewritten. Verification `VERIFY-a7650d01-444c-4929-ae8b-e6757cec6cab` passed all six check groups at 11:16:34 UTC and produced `ARTIFACT-acd94f37-fb77-48bc-9dbf-4499b7e65341`. Both the failed first attempt and passed second attempt remain immutable.

Explicit API Resume retained execution RUN-0930f30b-70bc-431b-8f57-0e53e75d927e and Coder turn 94. SL consumed the terminal receipt, returned resolved within existing authority, and Coder completed report_done at turn 95 without more edits, commits or verification. Review preparation then detected REVIEW_POLICY_CONFLICT: blocker transport had omitted review_cycle_id, causing the repair to be compared with the historical soft-review cycle.

Common recovery now binds review_cycle_id from Node's retained execution context before dispatch, completion policy and automatic review preparation. A supplied conflicting cycle remains rejected. Historical review policy/jobs are not rewritten; Owner-authorized repair uses its separate blocking-review cycle. Regression tests prove the independent review runs before integration despite omitted transient metadata and that the original soft-review record stays unchanged.

A common thirty-second verification-wait recheck also returns parked SL coordination to pending when new same-source terminal evidence arrives. Both passed and failed checks return to SL, not directly to Coder acceptance. Duplicate terminal receipts remain deduplicated across worker restart; Stop, stale execution/source and mixed external prerequisites remain parked. Wake/recovery/wait focused check: 23/23 PASS; cycle/resume/recovery/completion check: 25/25 PASS. Scoped ESLint PASS. These final review-cycle and wake changes require API reload before runtime use; current ticket is not accepted or done.


## Live review resumed (2026-10-19 11:22 UTC)

After Control API reload, RUN resumed completed Coder evidence directly into independent blocking review. Ticket status is reviewing; Reviewer checkpoint is in_progress, review_gate=on, request REVIEW-dd94646896bf879bc961515fbbcc6fc07aa2738faebd557400ef51da89161355, commit 832a9c2928600cc1ea75db39fa74c152bf8308fd. No Coder reimplementation or new verification was dispatched. The original execution, repair cycle, turn-95 report, original ticket commit and passed artifact are preserved. The serving API now includes both common verification-wait polling and canonical review-cycle restoration. Final focused review/repair/recovery check: 41/41 PASS. Independent review outcome remains pending; this is not ticket completion or production acceptance.


## Live ticket completed (2026-10-19 11:26 UTC)

Independent Reviewer finished at 11:26:08 UTC; normal verification/review/integration gates completed and terminal status synced to done at 11:26:10 UTC. API confirms TICKET-NF-MPA-LIFECYCLE-01 is done. Reviewed source is 832a9c2928600cc1ea75db39fa74c152bf8308fd with passed artifact ARTIFACT-acd94f37-fb77-48bc-9dbf-4499b7e65341; the original Coder repair remains 9dac62cf47a13d752a8f6bfd3aac7084ad283704. Integration receipt and file-claim release were emitted normally; the terminal summary was folded into project memory. This supersedes the earlier pending-review observations above. No forced status/approval, checkpoint reset or Git push was used to achieve completion. Common recovery is active for other eligible tickets through shared verification, blocker polling and review-cycle services; unrelated historical tickets were not started or relabeled.

## Ticket commit ownership and recorded verification environment (2026-10-19)

This supersedes the earlier dependency-only committed-source refresh policy above. The separate dependency commit fixed the historical LIFECYCLE execution but must not be a general prerequisite for verification. The common service no longer selects a dependency commit or changes the ticket review commit automatically. Historical receipts and the completed ticket remain untouched.

- Commit ownership remains the ticket ledger's whole-file paths, including additions/deletions. Unrelated dirty/staged/untracked paths are neither staged nor committed; root Git index and HEAD preservation are covered in regression tests.
- Root-ticket verification materializes ticket-owned bytes from their recorded commit and every other eligible project file from a separately captured workspace environment. Uncommitted dependencies are allowed. Git-ignored secrets, runtime files and unmanaged symlinks are excluded; existing managed node_modules links remain dependencies of the runner.
- Environment manifests and deduplicated content-addressed blobs are retained under `.forge/runtime/ticket-verification/environment/`. Atomic publication handles concurrent snapshots without exposing incomplete blobs. Artifact v7 binds the environment hash separately from ticket authorship, commit/tree and acceptance verification plan.
- Independent hard/soft review uses the same recorded environment bytes outside the ticket and committed bytes inside it, even after live workspace changes. Ticket source drift and tests modifying captured input files still fail validation.
- A repaired environment admits fresh verification for the same ticket commit after an earlier retry limit. Passed snapshots remain valid despite later unrelated workspace edits. Latest diagnostics sort by time across environment revisions, rather than preferring an older revision's larger retry count.
- Backend checks target surviving ticket source files, related tests and explicitly mapped acceptance tests. Deleted paths are not passed as missing source inputs to lint/typecheck. Mapped backend tests are deduplicated and do not require automatic import discovery to find them first. Schema/browser gates and independent review remain required by policy.
- Unfinished legacy verification evidence refreshes under v7 without a new Coder commit. No runtime migration, reopened completed ticket, new approval or fabricated PASS is performed.

Verification: 54/54 focused regression tests PASS across root commits/retries/concurrency/workspace, verification worktree/environment/recovery/policy/attempts, focused checks, independent review and blocker evidence/waits. Final targeted recheck after mapped-test selection adjustment: 8/8 PASS. Includes actual Node execution importing an untracked dependency in a disposable Git repository, preserved index/HEAD, additions/deletions, environment repair after failed retries, snapshot tampering, concurrent evidence publication, old artifact refresh, and review after live source drift. Scoped ESLint and whitespace checks PASS.

Deployment status: code is saved; the serving Control API has not been restarted for this policy change. Reload `/r api` once to activate. No live ticket execution or production acceptance is claimed for the new policy.

## ROUTING-02 missing persisted findings (2026-10-19 15:04 UTC)

Root cause: automatic post-completion review (`review_gate=off`) retained a completed `request_changes` checkpoint with two findings while its durable finding store remained empty. Owner Resume selected the repair path, which correctly refused to run Coder without persisted findings. This was not a missing verification commit.

The common automatic review path now persists findings for both blocking and post-completion reviews before recording/publishing the outcome, with exact source validation. A failed finding write produces `review.failed`, not a usable `request_changes` outcome. Legacy repair restores only missing findings from a completed independent Reviewer checkpoint bound to the same task, commit, artifact, manifest and source revision. Repeated recovery is idempotent; partial stores and independent adjudications are retained. No closed finding is reopened by recovery.

Runtime repair used the production finding/context stores under the Owner review-operation lock. Restored REV-1 (historical read-access evidence) and REV-2 (missing selected-project session verification) for TICKET-NF-MPA-ROUTING-02. Receipt/backup: `.forge/runtime/review-findings-recovery/TICKET-NF-MPA-ROUTING-02/2026-10-19T15-04-04.197Z/receipt.json`. Repeated restoration preserved the store version/content. Original Reviewer checkpoint, terminal execution context, source commit and ticket status were not changed; no agent was launched. Ticket remains reviewing and can enter the existing repair Resume path.

Verification: 31/31 focused review/recovery/source/workspace tests PASS; final automatic-review suite 13/13 PASS including the additional persistence-failure regression (32 distinct focused tests total). Scoped ESLint and diff checks PASS. General prevention requires loading the saved code in Control API; restored runtime findings are already persisted.

## ROUTING-02 stale dependency repair boundary (2026-10-19 15:22 UTC)

The Owner stopped ROUTING-02 after its repair dispatch failed before any provider launch. The durable dependency expectation still selected LIFECYCLE execution `RUN-4af52eed-b890-469d-9de2-300a1ea06329`; LIFECYCLE had since legitimately completed finding repair as `RUN-0930f30b-70bc-431b-8f57-0e53e75d927e` under the same immutable Sprint revision and scheduling version. Ordinary submission correctly rejected this stale identity. The initial completed-review handoff had already marked ROUTING running, leaving a misleading running status when submission failed.

The shared RUN boundary now explicitly reconciles dependency execution replacement only for parked Owner-reopened finding repairs. Replacement must retain the exact dependency set, immutable Project/Sprint/plan identity and scheduling versions, and have a done status, terminal context, passed artifact and completed integration receipt agreeing on task/project, commit, artifact, manifest, source and baseline. A transactional CAS rechecks downstream execution/version/ownership and upstream versions before recording the new dependency expectation. Active launch claims, changed plans, incompatible scope and incomplete evidence remain conflicts. An immutable content-addressed receipt preserves previous and replacement expectations. Receipt publication followed by a crash can be retried without duplicating the transition. Coder execution identity, findings and checkpoint are preserved. Fresh RUN and ordinary submission/launch fences are unchanged.

Completed-review repair logs preparation as pending rather than claiming Coder has started. A submission failure without an active launch parks the ticket as failed (or pending through the existing retry policy), preserves its prepared checkpoint and logs the original error code. A concurrent status conflict is separately logged without masking the submission error.

Runtime reconciliation used production File Service, Markdown/Human Plan Stores, Sprint Registry, execution context and Ticket Status Store. Exact approval and immutable source validation passed before mutation. ROUTING remains pending, version 33, under `RUN-a54e4d3a-433f-4282-9148-65c644acde2e`; Coder checkpoint turn 127, review checkpoint and execution context were compared unchanged after repair. LIFECYCLE remains done, version 44. No agent was launched or approval changed. Repeated reconciliation was a no-op.

- Backup: `.forge/runtime/review-dependency-reconciliation/backups/TICKET-NF-MPA-ROUTING-02/2026-10-19T15-21-51.894Z.json`.
- Reconciliation receipt: `.forge/runtime/review-dependency-reconciliation/7ff2af024d2a50caebc27c43160436154c0cfaaf9083bd685350610cd184f1c9.json`; SHA-256 matches the filename.
- Focused verification: 46/46 PASS across dependency reconciliation/dispatch, completed review findings/resume/workspace, launch ownership/restart and Sprint RUN basis. Includes real SQLite transactions, checkpoint-preserving shared RUN dispatch, concurrent upstream/downstream changes, retained launch rejection and recovery after receipt publication.
- Scoped ESLint and `git diff --check`: PASS. Restart-source tests now compare hashes captured at the beginning/end of the same run; approved-submission fixture now supplies a real durable execution claim and dependency intent.
- Broader exploratory checks additionally found 10 failures in existing dependency submission/revalidation/execution-fencing tests: fixtures do not satisfy current blocking-review prerequisites, an active dependency cannot be rebound under the Registry mutation guard, and a legacy failure-event expectation is stale. Temporarily satisfying those fixture prerequisites also exposed Claude MCP conversion rejecting conditional JSON schemas before provider dispatch (`Conditional schemas (if/then/else) are not supported`). Those exploratory fixture edits were reverted; no review guard or SDK schema conversion was weakened in this fix. This report does not claim the broader suites pass or that a real provider repair has completed.

Deployment: the stopped runtime record is already reconciled. The serving API still needs one reload to activate the general prevention/dispatch-failure handling; no automatic Coder Resume was requested or performed after Stop.

## General false execution-admission recovery (2026-10-19)

Root cause: a complete original `search_text` receipt reported `TOOL_INPUT_INVALID`, but the technical-failure allowlist omitted that code. The historical Coder `ACCESS_REQUIRED` label therefore triggered Architecture admission handling. Admission then searched an edit/commit-only receipt set for an approval denial that did not exist and parked the ticket with `EXECUTION_ADMISSION_EVIDENCE_REQUIRED`.

The shared classifier now recognizes tool-input diagnostics from execution-bound server receipts. Admission reads failures from all tools and distinguishes genuine coded/prose denials, including `COMMIT_APPROVAL_REJECTED`, from agent labels and missing evidence. An unsubstantiated admission request produces actionable disposition correction for SL instead of a missing-denial dead end. Genuine denials, incomplete evidence accompanying actual denials, approval decisions and tool permission gates are preserved.

The normal recovery worker rechecks legacy missing-denial waits. Only complete technical receipts and current execution/plan/source authority can return a wait to SL. It preserves the original failure, Coder checkpoint and execution; retains previous resolution/feedback in history; and respects Owner Stop. Partial, unknown, actual-denial and stale-authority cases cannot auto-resume through this correction. This mechanism applies across tickets without ticket-ID-specific status rewrites.

Node also supplies current Reviewer read-access diagnostics using actual Reviewer tools pinned to the retained reviewed artifact. Access checks do not close findings or issue a review verdict. The production-shaped blocker fixture places identity in `job.request`, ensuring the Reviewer tool authorization context receives the current task ID.

Verification: 63/63 focused tests PASS across input/admission classification, actual denial protection, recovery restart/Stop, original receipts, SL/AM handoff, progress and verification/503 recovery. The final Reviewer authorization-context adjustment additionally passed 3/3 Reviewer access tests. Scoped ESLint and whitespace checks PASS; all changed code/test files remain at most 250 lines.

Read-only runtime inspection of ROUTING-02 job `0397aafed638063476302cf14c5726556ae32ed67dd0c358f3c487ac32c09b9b` confirms complete technical classification from original event `LOG-8cbe6d4c-0e4e-4891-a55d-d5319f75e30f`. Actual Reviewer tools successfully read 14/14 artifact sources at commit `3ea1526be887feeccea24320ff85f0d91406ca54`, plus project instructions/current role rules. Findings/verdict remain unchanged. Checkpoint is still turn 134; runtime was not mutated and no agent was launched during inspection.

Deployment: code saved, not yet loaded by serving Control API. One `/r api` activates the shared recovery worker; an eligible non-stopped false-admission wait then returns to SL automatically. This report does not claim that live Coder/Reviewer repair or ticket acceptance has completed.

## Grouped test acceptance mapping (2026-10-19)

Owner stopped ROUTING-02 before investigation; it remains cancelled with Coder turn 166 preserved. The actual completion loop was not caused by a failing test: immutable artifact `ARTIFACT-c3ade069-5aa4-4049-a0af-d5a5a0381173` for commit `d13f7313e1554574f7651cdaca2198a3dd73634c` passed all commands, including the mapped routing module (4/4 tests). Node's planner deduplicated that `test` step into a `backend_tests` command, but coverage required strict equality of those labels. Completion therefore rejected AC-1 through AC-5, even after Coder reran the same test successfully.

Plan coverage and final report validation now share an exact-receipt matcher. A successful grouped backend command can satisfy a focused `test` step only when its argv contains the exact mapped test path. Coverage stores the actual receipt kind (`backend_tests`), so the later report gate agrees with the coverage calculation. Legacy supplied `test` hints use the same rule. Failed/missing/wrong-path receipts, unrelated command kinds, additional required checks, browser assertions and source/artifact gates remain enforced. No immutable plan, receipt or acceptance requirement is rewritten.

Verification: 27/27 focused tests PASS across evidence/report gates, command selection and verification recovery. Regression uses the real planner and executes its selected test in a disposable repository, then retries report_done through both report branches using the same artifact without another test launch. Recovery tests cover concurrent requests and a running job reused across retries/restart, proving `VERIFY_RECOVERY_PENDING` itself does not create duplicate jobs or claim PASS. Read-only recalculation against the existing runtime artifact maps AC-1 through AC-5 to verified evidence; no final report, finding, checkpoint or status was mutated and no agent was launched. Scoped ESLint and whitespace checks PASS.

Additional browser suite: 8 PASS, 2 FAIL due to existing fixture assumptions (`TMPDIR` absent and expected policy v6 versus current v7). Its actual browser receipt matching/report tests PASS. These unrelated fixture failures were not changed or represented as a full-suite PASS.

Deployment: serving API still needs `/r api` to load this matcher. Owner Stop remains in effect; restarting API must not resume the ticket automatically. After an explicit later Resume, completion can reuse the existing passed artifact if ordinary source/identity checks still validate it; independent Reviewer adjudication remains required.

## Reviewer verdict identity and correction (2026-10-19)

The actual failed Reviewer response was recovered from its Codex session, rather than inferred from the generic validator error. It returned two substantive request_changes findings and adjudications using invented `NF-MPA-ROUTING-02-R1/R2` IDs. The durable finding store uses `REV-1/REV-2`. Role prose also requested unsupported outcome labels and did not state who allocates IDs. Node previously discarded the useful response from its own checkpoint and stopped at a generic four-field diagnostic.

The shared Reviewer prompt and role rules now specify Node-owned finding IDs, exact existing IDs for adjudication/refinement, and supported JSON outcomes. Validation reports the precise failing field, unknown/duplicate IDs, missing reasons/evidence and unanswered pending Coder responses. New findings receive Node IDs; a refinement bearing a known ID updates that finding with preserved prior text/evidence rather than allocating a duplicate. Unknown IDs and reopening closed findings through relabeling are rejected.

For Codex, Claude and OpenAI, malformed output now returns exact diagnostics and the original response to the same independent Reviewer for at most two correction requests. Correction has no tools and does not repeat discovery, dispatch Coder, infer an ID mapping, close a finding or change a verdict. Each response/diagnostic is bounded, credential-redacted and retained in the Reviewer checkpoint; provider/session telemetry remains logged. Source is revalidated before correction and after the final response. Provider errors and source drift are not relabeled as format errors. Persistent invalid output remains failed with its original error.

An explicit later review retry can reuse a failed response/session only when task, Reviewer, project, commit, artifact, source revision, manifest and baseline still match. Completed source-discovery turns are preserved. The prompt also distinguishes latest-commit changed_paths from the full base-to-review patch, without waiving checksum, dependency-provenance or acceptance checks, and states tool output/window budgets.

Runtime preparation for ROUTING-02 restored the original invalid SDK response into its failed Reviewer checkpoint under the Owner review lock. Backup/receipt: `.forge/runtime/review-format-recovery/TICKET-NF-MPA-ROUTING-02/2026-10-19T16-59-35.952Z/`. Reviewer remains failed at turn 15 with no accepted verdict. Coder remains completed/coder_reported at turn 167; its code, report and artifact are preserved. The checkpoint store mirrored updated Reviewer-stage diagnostics into ticket metadata. No agent was launched and no finding was adjudicated by this recovery. The original substantive findings concern revision/provenance clarity and routed-operation session evidence; independent Reviewer/Coder processing is still required after valid output.

Verification: 60/60 focused tests PASS across verdict parsing/correction, all three providers, source-bound session recovery with real Git fixtures, finding-store refinement/restart, pending Coder responses, automatic review/recovery/cycle handoff and approval/integration guards. Scoped ESLint and diff checks PASS; touched files remain within 250 lines. Serving API requires one `/r api`; then explicit Resume retries Reviewer at its retained session. This report does not claim live corrected Reviewer output or final ticket acceptance.


## Uncapped finding-driven repair (2026-10-19)

Removed numeric review-revision checks from automatic repair, Supervisor event repair, and retained completed-review repair. Existing persisted numeric limits are ignored; the review gate remains immutable. Each decision still consumes one deduplicated repair receipt. Independent approval, source identity, unresolved findings, Stop and unchanged-revision checks remain required. Operational provider retries are separate from finding-driven revision count.

Focused checks: 65 tests PASS across automatic review completion/identity/recovery/cycle, Supervisor loop, completed review Resume and repair workspace. Regressions cover four successive repairs despite legacy limits zero/one, retained capped jobs after reload, idempotent repair consumption and final independent approval. Scoped ESLint and diff checks PASS.

Runtime ROUTING-02 changed from needs_human_review version 58 to pending version 59 through Ticket Status Store with optimistic version/execution checks. Coder completed turn 40, Reviewer request_changes and open REV-4 are preserved byte-for-byte. Backup/receipt: `.forge/runtime/review-limit-recovery/TICKET-NF-MPA-ROUTING-02/2026-10-19T17-34-43.978Z/`. No agent launched. API reload is required before Resume uses the uncapped shared implementation.


## Node-owned report verification wait (2026-10-20)

A single `report_done` now remains suspended on Node verification until a terminal result, instead of returning a ten-second pending error and asking the agent to poll. The same SDK session receives the result and finishes reporting or repairs the evidenced failure. The shared checkpoint wrapper persists the report draft, verification job/source identity, provider session and completed turn before announcing a wait. Stop aborts continuation; waiting does not emit failure or human-review status. Explicit Resume after restart retains this draft/session; unresolved provider launch ownership still requires the existing reconciliation and is not automatically bypassed.

Terminal errors, including an already-exhausted unchanged retry, include the existing artifact/command diagnostic in structured tool details. Codex completion MCP timeout follows the session deadline; its bridge uses a native HTTP request so fetch's fixed response-header timeout cannot cut off a long verification call. Wait and terminal notices reach persisted project logs, terminal and agent activity panels without exposing source output.

Focused verification: 66/66 PASS across report/checkpoint waits, PASS/FAIL/Stop/restart resume, existing report gates, Codex gateway/actual MCP bridge, and panel activity. Scoped ESLint and diff checks PASS. Additional provider catalog/Supervisor checks produced 9 PASS and 4 FAIL: Claude JSON-schema conversion rejects conditional schemas; three Supervisor fixtures lack hard-review dependencies. Those setup failures occur before the new wait and are unresolved here. No live ticket state, approval, commit, or verification result was changed. API reload is required to use the saved implementation.

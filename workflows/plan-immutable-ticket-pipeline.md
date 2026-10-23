<!-- Architecture plan: immutable ticket execution context and evidence chain. -->
# Plan — Immutable Ticket Execution Pipeline

> **Architecture update (2026-09-30):** The root-only commit decision in `docs/giai-doan-3/root-only-ticket-commit-plan.md` supersedes model B's reconstructed ticket worktree for new executions. Historical worktree evidence below remains an audit record; it must not be relabeled as root-only evidence. The new chain is root File Service write and ledger revision → serialized root commit → archive verification → review of that commit → terminal receipt. Root-only rollout remains explicitly gated by its migration and canary criteria.

## Status and decision

**Status:** implementation and acceptance recovery are in progress. A1, scoped A2, and A3 have current passing witnesses; the epic remains open and release-blocked by A4–A6. Treat this document as the binding rollout plan, not as a claim that the epic is accepted.

Adopt **model B**: the project root remains the live source used by Forge, Coder, root watcher/index, and normal discovery. A ticket worktree remains a deterministic commit/review receipt reconstructed from the ticket ledger. This is permitted only when every handoff is bound to the same immutable identity chain:

```text
root snapshot + ledger revision
  ↔ execution context + manifest
  ↔ reconstructed worktree commit
  ↔ durable verification artifact
  ↔ review evidence and verdict
  ↔ serialized integration receipt
```

No feature/UI ticket may depend on `approved` as proof that the reviewed commit passed verification until **NF-PIPE-CTX-001**, **NF-PIPE-VERIFY-002**, and **NF-PIPE-REV-003** are accepted. Existing tickets may be recovered or escalated, but must not be silently reclassified as conforming.

## Non-negotiable invariants

1. The Supervisor creates one persisted `TicketExecutionContext` before dispatch and only Node-owned services may mutate its state transitions.
2. Coder/Forge/Reviewer reads and ticket writes use the declared `execution_root`. Under model B this is the project root; a Reviewer must never read a root/cache version as evidence for a worktree commit without checksum identity proof.
3. `manifest_paths` is Supervisor-owned: it is derived from the durable ledger and finalized as a versioned manifest. Agent-supplied `changed_paths` is advisory input only and cannot narrow verification scope.
4. A ticket commit is valid only when deterministically reconstructed from the context base SHA, the locked ledger revision, and manifest hashes. A root-to-worktree bulk copy is forbidden.
5. `verification.passed`, `report_done`, review dispatch, approval, integration, and file-claim release are hard-gated by matching immutable identities. In-memory test jobs are never final evidence.
6. A Reviewer can approve only the exact `review_commit_sha` that matches a passed verification artifact. If source/commit/artifact cannot be materialized or compared, the only outcomes are `request_changes`, `blocked`, or `needs_human_review`.
7. Every required review finding has an ID and durable resolution state. Revision-limit escalation cannot substitute for identifying unresolved findings.
8. The canonical public error wire contract is `{ code, message, retryable, scope, requestId }`. Compatibility adaptation is allowed only at an ingress/egress boundary, never as a second semantic contract.

## Required persisted records

### Ticket execution context

Create atomically before the first Coder dispatch; store under existing project runtime persistence with ownership, locking, idempotency, and recovery semantics.

```json
{
  "task_id": "...",
  "project_id": "...",
  "supervisor_id": "...",
  "base_sha": "...",
  "execution_root": "project-root",
  "source_revision": "ledger-revision-or-snapshot-id",
  "manifest_paths": [],
  "manifest_sha": "...",
  "verification_artifact_id": null,
  "review_commit_sha": null,
  "state": "created|coding|committed|verified|reviewing|integrating|terminal"
}
```

`source_revision` names a reproducible root snapshot: locked ledger revision plus ordered per-path before/after hashes and snapshot/patch references. It is not an unqualified mutable root HEAD. Context updates use compare-and-swap/versioning, emit correlation metadata, and are recoverable after restart.

### Verification artifact

Persist an immutable, redactable receipt before publishing a pass event:

```json
{
  "artifact_id": "...",
  "task_id": "...",
  "context_revision": "...",
  "source_revision": "...",
  "base_sha": "...",
  "commit_sha": "...",
  "cwd": "...",
  "manifest_sha": "...",
  "file_checksums": {},
  "commands": [],
  "exit_code": 0,
  "stdout_redacted": "...",
  "stderr_redacted": "...",
  "status": "passed|failed|error",
  "started_at": "...",
  "completed_at": "..."
}
```

The artifact must record the actual Node-run commands and policy/plan version. Redaction occurs before persistence and before SSE/log projection; full unredacted output is not placed in prompts, events, or ticket records.

### Review finding

```json
{
  "finding_id": "REV-1",
  "status": "open|fixed|not_fixed|not_applicable",
  "severity": "blocker|major|minor",
  "changed_paths": [],
  "evidence_refs": [],
  "resolved_revision": null
}
```

A new review may mark a prior finding fixed only with evidence tied to the newer context/commit; it must not erase prior findings.

## Dispatch and gate sequence

```text
create context + empty ledger
→ Coder writes through root ticket-aware File Service
→ ledger transaction updates source_revision and manifest
→ deterministic worktree reconstruction / commit
→ lock context to commit + manifest hashes
→ Node runs verification on that exact materialized revision
→ persist passed artifact
→ dispatch Reviewer with commit + artifact + checksum manifest
→ accept structured verdict only after identity comparison
→ serialize integration of approved reviewed commit
→ persist integration receipt, then release claims and terminalize
```

For root-level checks that inherently require the live project, record a distinct environment result but do not use it as proof for review. The review gate requires verification of the exact reconstructed commit. Any root drift before integration requires revalidation or a conflict/escalation; no stale artifact may be reused.

## Ticket backlog and dependencies

| Ticket | Owner | Depends on | Objective and acceptance gate |
| --- | --- | --- | --- |
| **NF-PIPE-CTX-001** | Coder + independent Reviewer | existing ledger/worktree plan | Add persisted execution context, state/version/CAS recovery, root execution-root wiring, Supervisor-created immutable manifest contract, and context propagation through Coder, Collector, Commit, Verification, Reviewer, and Resume. Test restart and root/worktree divergence. |
| **NF-PIPE-VERIFY-002** | Coder + independent Reviewer | CTX-001 | Replace path-only verifier pass with Node orchestration that materializes the context commit, executes required build/lint/typecheck/test plan, and persists redacted immutable artifact. Gate `report_done`, `verification.passed`, and review dispatch on artifact/context equality. Prove restart retains evidence. |
| **NF-PIPE-REV-003** | Coder + independent Reviewer | CTX-001, VERIFY-002 | Materialize Reviewer evidence from `review_commit_sha`; compare base SHA, context revision, manifest SHA, and file checksums against the verification artifact before accepting approval. Preserve read-only Reviewer Forge tooling and fail closed when unavailable or mismatched. |
| **NF-PIPE-FIND-004** | Coder + independent Reviewer | REV-003 | Introduce finding IDs, state machine, evidence references, and resolved revision; route only unresolved required findings into revision prompts. Block terminal acceptance while required findings remain unresolved. |
| **NF-PIPE-ERR-005** | Coder + independent Reviewer | CTX-001 | Publish one canonical error envelope and migrate HTTP/SSE/application producers. Keep `recoverable`/snake-case only in explicitly tested boundary adapters with a removal deadline. |
| **NF-PIPE-E2E-006** | Test-focused Coder + independent Reviewer | CTX-001 through FIND-004, ERR-005 | Establish failure/recovery matrix and release gate below. No mocked in-memory receipt may satisfy these tests. |

CTX-001, VERIFY-002, and REV-003 are strictly sequential. FIND-004 and ERR-005 may run in parallel after their stated dependency. E2E-006 is last.

## Required failure/recovery matrix

E2E-006 must cover: concurrent tickets on the same file; disjoint dirty root changes; root/worktree divergence; restart between verification and review; source mutation during review; stale/missing/mismatched artifact; untracked, created, deleted, and renamed files; repeated finding across revisions; unavailable Reviewer tools; commit/rebase/integration conflict; duplicate dispatch/event; and legacy error-envelope adaptation. Each case must assert terminal state, retained/released claim behavior, context/artifact IDs, and absence of false approval.

## Migration and rollout

1. Inventory active worktrees, checkpoints, ledgers, cached test jobs, and review-only requests. Classify each as migratable, stale, or human-review-required; do not auto-claim paths, rewrite commits, or attach an artifact retroactively.
2. Ship context persistence and read-only observability first; shadow-record identity comparisons while legacy gates remain authoritative.
3. Enable hard verification and review gates behind a project-scoped feature flag. On any identity mismatch, fail closed and preserve evidence.
4. Remove legacy root/worktree reconciliation as an evidence source after migration. It may remain only as deterministic reconstruction governed by the execution context.
5. Remove compatibility error fields after consumers have migrated and the announced boundary window expires.

## Acceptance-recovery execution order

The implementation tickets are not to be reopened as feature work. Run the following acceptance work as a release-blocking sequence, preserving every fixture, command result, and persisted IDs in the acceptance record.

| Order | Work package | Owner | Preconditions | Required proof and exit decision |
| --- | --- | --- | --- | --- |
| A1 | **Production composition witness** | Test-focused Coder + independent Reviewer | Disposable integration suite remains green; a non-production project/fixture can start the real Control API composition. | Start the real composition, dispatch a ticket, restart between verification and review, redeliver duplicate dispatch/event, then assert persisted context/artifact/review/integration IDs and correct claim retention/release. Missing composition dependency is `blocked`, not a mocked substitute. |
| A2 | **Provider Reviewer witness** | Coder + independent Reviewer | A1 harness can materialize the exact review commit; provider credentials and network authority are explicitly available. | Dispatch through the configured production Reviewer provider path and its read-only Forge/MCP policy. Prove tool audit evidence is tied to the verified commit and reject a changed commit, manifest, checksum, missing artifact, and unavailable tool. If credentials/network are unavailable, retain the offline SDK fixture and record `needs_human_review`; do not infer provider acceptance. |
| A3 | **Shadow routing and identity comparison** | Coder + independent Reviewer | A1 proves restart/duplicate recovery; inventory remains read-only. | For every eligible event, compute and persist shadow context → manifest → commit → artifact → review identity comparison without changing legacy terminal behavior. Restart during a shadowed event and prove idempotent comparison. A startup classification count alone does not pass this package. |
| A4 | **Legacy-record disposition** | Sprint Leader / human owner, with Coder support | A3 is operating; inventory is refreshed immediately before decision. | Assign each of the 15 active legacy records a durable disposition: migrated only with complete evidence, cancelled/cleaned under policy, or `needs_human_review`. No automatic relabeling, artifact backfill, commit rewrite, or claim takeover. Enforce cannot proceed with an undispositioned record. |
| A5 | **Error-consumer migration closeout** | Coder + independent Reviewer | Consumer and historical-message inventory is complete. | Test actual HTTP, SSE, and application consumers against only the canonical envelope. Keep compatibility adapters only at named boundary adapters; before **2026-10-13**, either remove them after the audit or obtain and record an explicit human extension. |
| A6 | **Enforce canary and release decision** | Sprint Leader / human release authority | A1–A5 pass and trace log is complete. | Enable the project-scoped hard gate for a bounded canary. Assert all mismatches fail closed with no false approval or claim release; monitor rollback and recovery. Release authority accepts the epic only from the signed evidence record, otherwise leaves it open. |

### Next execution plan — release-blocking closeout

This is the authoritative next-step order for the current acceptance state: A1, scoped A2, and A3 have current passing witnesses; A4 and A6 are blocked, and A5 is partial. The acceptance record already retains the historical A1/A3 attempts and identifies the current passing witnesses. Do **not** enable enforce before all gates below pass.

#### First action — persist the atomic A5 execution ticket

Before restarting the API or dispatching `RUN`, the Sprint Leader must create and persist one atomic A5 ticket in the durable ticket ledger. The ticket must be approved and assigned to a Ticket Supervisor; an informal prompt, an unpersisted request, or a ticket created after `RUN` is not valid execution evidence.

The persisted ticket must include:

- **Scope:** A5 error-consumer migration closeout across HTTP, SSE, Node client, UI, and the 18 JSONL / 2,305-message historical corpus, including the 50 messages with legacy error fields.
- **Acceptance criteria:** actual consumers use only `{ code, message, retryable, scope, requestId }`; every compatibility adapter is named and boundary-only; each legacy-field consumer is removed or covered by an explicit human extension before **2026-10-13**; no replay-only result is accepted as closure.
- **Verification plan:** run the real consumer and historical-message audit, record exact commands/results and message counts, test adapter behavior and removal/extension, persist redacted evidence, and compare context, manifest, commit, artifact, and review identities. Restart and duplicate dispatch must be idempotent and must not release claims early.
- **Owner and authorities:** Sprint Leader as ticket owner, named Ticket Supervisor, Coder, independent Reviewer, and—if an extension is required—the human authority who can approve its owner, scope, expiry, and risk.
- **Dependencies and gate:** A3 passing witness and refreshed A5 inventory; A4 may proceed in parallel but is not silently treated as an A5 dependency. The ticket must remain `shadow` and release-blocking until A4–A5 pass and A6 is signed.

Persist the ticket ID, ledger revision, owner/authority assignments, acceptance criteria, verification plan, and idempotency key in the acceptance trace before any API restart. Only then may the Supervisor restart the real Control API, recover the persisted context, and call `RUN` with that exact ticket ID. A restart or `RUN` of an arbitrary ticket does not satisfy A5.

#### A5 execution incident — baseline conflict (blocked)

The persisted ticket `NF-PIPE-ERR-005-A5` was dispatched once and fail-closed with `TICKET_BASELINE_CONFLICT`. This attempt is **not A5 evidence** and must not be resumed or retried merely by restarting the API. Preserve its worktree, ledger, commit, and logs; do not reset, stash, overwrite, commit, or auto-reconcile.

The completed inspection establishes that the ticket worktree `.forge/worktrees/tickets/NF-PIPE-ERR-005-A5` is non-legacy and clean for its manifest path `backend/src/modules/supervisor/reviewer-forge-tools.js`; its `HEAD` and base SHA are both `a528c69a43304f0f80f5539b1465d092d41222dd`. Its execution context is `coding`, version `11`, and ledger revision is `10`. The project root, however, had an already-dirty delta of 23 added and 5 deleted lines when the ledger captured initial snapshot `sha256:4e81...`; reconstruction correctly uses the clean base content instead. All ten A5 operations return to that initial ledger snapshot, leaving no separable A5 delta. Consequently, no automated reconciliation record or safe ticket commit can be created.

**Required human decision (choose exactly one, durably audited):**

1. Authorize the identified dirty initial snapshot as the legitimate A5 baseline, with a reconciliation record that names the approver, root delta identity/checksums, scope, risk, and replacement source/ledger revision; or
2. Close this blocked attempt without counting it as evidence, retain its audit trail, and create a new A5 execution context from a demonstrably clean baseline.

Until that decision and its replacement immutable baseline are persisted, retain `blocked` / `needs_human_review`, do not dispatch Coder or Reviewer, and do not restart/resume `RUN`. A4 continues independently; A6 remains prohibited.

1. **Start A4 and A5 now, in parallel.** After the atomic A5 ticket is persisted, refresh the A4 inventory immediately before a Sprint Leader/human owner decides every one of the 15 records: migrate only with complete evidence, cancel/clean under policy, or retain `needs_human_review`. Persist the decision with current inventory fingerprint, actor, and evidence references. Do not auto-migrate, relabel, rewrite commits, or take over claims. For A5, execute only the persisted ticket’s named production-consumer and historical-message audit for the 18 JSONL / 2,305-message corpus, including the 50 messages with legacy error fields, across HTTP, SSE, Node client, and UI. For A4, refresh the inventory immediately before a Sprint Leader/human owner decides every one of the 15 records: migrate only with complete evidence, cancel/clean under policy, or retain `needs_human_review`. Persist the decision with current inventory fingerprint, actor, and evidence references. Do not auto-migrate, relabel, rewrite commits, or take over claims. For A5, complete the named production-consumer and historical-message audit for the 18 JSONL / 2,305-message corpus, including the 50 messages with legacy error fields, across HTTP, SSE, Node client, and UI.
2. **Close the A5 adapter decision by 2026-10-13.** Remove compatibility adapters only after the audit passes; otherwise append an explicit, time-bounded human extension naming the owner, scope, expiry, and remaining consumer risk. A successful replay alone does not close this decision.
3. **Verify A4/A5 closure evidence.** A4 passes only when every active legacy record has a durable permitted disposition; `needs_human_review` remains a valid disposition but must remain enforce-blocking if policy requires human resolution. A5 passes only with the completed audit plus adapter removal or signed extension. Keep the project in `shadow` for either unresolved gate.
4. **Execute A6 last.** Once A4 and A5 pass and their trace/evidence records are complete, configure a human-authority release gate and run a bounded enforce canary. Verify mismatch fail-closed behavior, rollback, restart recovery, and duplicate-event recovery without false approval or premature claim release. The human release authority must sign the final evidence record; absent that signature, leave the epic open.

### Evidence-record format

Each package appends a durable, redacted record containing `package_id`, project/fixture identity, context ID, manifest SHA, base/source/review/integration commit SHAs, artifact ID, event/idempotency IDs, exact commands, exit codes, timestamps, result, and links to retained audit evidence. Secrets, raw source, and unredacted command output are prohibited. A failing or unavailable prerequisite records `blocked`/`needs_human_review` with the missing authority; it cannot be converted to a pass by a local mock.

## Completion definition

The epic is accepted only when an approved ticket has a persisted context, a deterministic commit, a passed durable artifact for exactly that commit, a review verdict with matching evidence, resolved required findings, and a successful integration receipt. A commit, a Coder claim, an in-memory test result, or a narrative report alone is not acceptance evidence.

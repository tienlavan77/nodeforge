<!-- Architecture decision: retire ticket Git worktrees in favor of a serialized root-only commit pipeline. -->
# Decision — Root-only ticket execution and commit pipeline

## Decision

The project adopts **root-only execution**. Ticket Git worktrees, ticket branches, worktree reconstruction, and worktree-to-root integration are retired from the normal pipeline.

This supersedes the earlier use of “model B” in `workflows/plan-immutable-ticket-pipeline.md`: that model retained a worktree as a commit/review receipt. The replacement model is **B-root-only**:

```text
root File Service write + durable ledger
→ immutable manifest / source revision
→ serialized root commit
→ verification of that commit from an archive materialization
→ review of that same commit
→ terminal receipt
```

The project root is the only live source and the root branch is the only commit history. A root commit is the integration; no later merge/rebase/integration step exists.

## Security and provenance invariants

1. Every ticket write still goes through the ticket-aware root File Service, per-path claim, checksum check, durable ledger, and operation idempotency.
2. The Supervisor freezes a ledger revision and manifest before commit. Agent-reported paths remain advisory and cannot expand or reduce the manifest.
3. `commit_changes` takes a cross-process project-wide **commit lock** and freezes the ticket ledger revision against further writes. Every Forge Git mutation uses the same lock. External Git mutation during the transaction must be detected where possible and fail closed.
4. Before staging, each live root path must equal its frozen ledger `after_sha`. A mismatch fails closed as `TICKET_SOURCE_DRIFT`.
4a. Every manifest path's **before-state blob must equal its blob at the locked parent `HEAD`**. Staging commits the whole blob as it exists, so a provable ticket delta alone does not isolate pre-existing dirt. A mismatch fails closed as `TICKET_BASELINE_CONFLICT`; the only resolution is an approved baseline-only root transaction (see Baseline policy) committed before the ticket claims the path.
5. The Git commit must contain exactly the frozen manifest paths and expected blobs, have the locked `HEAD` as parent, and persist its SHA plus tree ID before success is returned. Any unexpected staged/tree path fails closed as `TICKET_COMMIT_SCOPE_CONFLICT`.
6. Verification and review are bound to that commit SHA, manifest SHA, ledger revision, and per-path checksums. They must not use mutable root bytes as the evidence source.
6a. The verification gate must locate the ticket's `commit_sha` **within root history** and check its artifact/tree/manifest against the receipt — it must never assert `HEAD == commit_sha`. Under root-only serialization, a later ticket's commit legitimately advances `HEAD` before the earlier ticket finishes verification/review. The existing `HEAD`-equality checks in `ticket-verification-service.js` (`VERIFY_COMMIT_STALE`), `ticket-review-evidence.js` (`REVIEW_COMMIT_STALE`, including its clean-status assertion), and `ticket-integration-service.js` (worktree HEAD check) are worktree-model residue and must be replaced, not ported. Verification's `cwd`/`worktreeRoot` must also be repointed to the archive-materialized directory, so relative paths in the verification plan resolve against the committed tree rather than the mutable root.
7. Exact-commit verification uses a disposable directory made with `git archive <commit>` (and controlled dependency setup if required), **not** `git worktree`. The artifact records this materialization method and SHA.
8. A commit is not acceptance. Approval still requires a matching passed artifact, independent review evidence, resolved required findings, and terminal receipt.

## Root-only commit transaction

1. Acquire the serialized project commit lock, load the durable ledger, and freeze its current revision against further ticket writes.
2. Reject if the shared Git index has pre-existing staged changes. Under the lock, allocate a unique **commit transaction ID** and persist a prepared record containing ticket ID, ledger revision, manifest SHA, parent `HEAD`, transaction ID, and shared-index identity. Unstaged unrelated root changes may remain, but are never staged by this transaction.
3. Recheck the frozen manifest against the live root using existence, mode, and content checksums. Every manifest path's before-state blob must match the locked parent commit, as required by invariant 4a. A dirty path requires an approved baseline-only commit before the ticket claims it; a separately provable ticket delta cannot make the whole-file Git commit safe. Otherwise return `TICKET_BASELINE_CONFLICT`.
4. Build the candidate tree in a transaction-private Git index initialized from the locked parent. Stage only literal manifest paths there; compare the resulting diff, modes, deletions, and blobs with the frozen ledger snapshots. A preparation failure must leave the shared index untouched.
5. Create a commit object carrying the transaction-ID trailer, advance the root branch with a compare-and-swap check against the locked parent, and synchronize the shared index to the committed tree only if its recorded identity still matches. Persist `{ transaction_id, parent_sha, commit_sha, tree_sha, ledger_revision, manifest_sha, path_checksums }` atomically in the context/receipt journal before returning success. An index or ref mismatch quarantines the transaction rather than overwriting another actor's work.
6. Materialize the committed tree through `git archive` into a disposable non-worktree directory; run the required verification plan there and persist the redacted immutable artifact.
7. Give Reviewer the committed diff, archive-bound artifact, manifest, and read-only source material resolved from the commit. A root change after commit requires no re-commit, but it cannot change review evidence.
8. On approval, persist the terminal integration-equivalent receipt and release claims. On rejection or artifact/review mismatch, retain claims and create a new ledger revision; never amend the reviewed commit.

## Concurrency and recovery

- File claims serialize overlapping ticket writes. The project commit lock serializes all root commits, so the current root `HEAD` becomes the next ticket’s parent.
- If another process changes a claimed file before commit, fail closed; do not stash, reset, overwrite, or auto-merge it.
- Commit messages carry the transaction ID as a trailer so recovery identifies the commit unambiguously; two different transactions can legitimately produce identical trees.
- The prepared record tracks recoverable phases: prepared, commit object created, branch ref advanced, shared index synchronized, and receipt persisted. A crash before branch advancement leaves the shared index untouched. If the ref advanced but the index is still at its recorded identity, recovery may synchronize it to the committed tree; any other index state is quarantined.
- If a crash occurs after Git creates a commit but before receipt persistence, recovery searches only for a commit whose parent, tree, manifest paths, frozen checksums, and transaction-ID trailer all match the prepared transaction. It finalizes that receipt idempotently; otherwise it quarantines the ticket for human review. A matching tree alone is insufficient.
- No operation may run `git reset`, `git stash`, bulk `git add .`, or broad pathspec staging.

## Baseline policy and the blocked A5 attempt

The existing `NF-PIPE-ERR-005-A5` attempt remains blocked historical evidence and is **not** migrated or resumed. Removing worktrees does not make its 23-added/5-deleted pre-existing root delta attributable to A5.

If the approved decision is to retain that dirty state, the authorized human must first create a **separate root baseline transaction**: record approver, owner, exact paths/diff, before/after checksums, risk, timestamp, and a baseline-only commit SHA. Its message must state that it is not A5 evidence. The old A5 context is then closed, and a new A5 context starts from the resulting root `HEAD`.

If that baseline cannot be recorded with this evidence, retain `blocked/needs_human_review`; do not stage or commit it through A5.

## Migration plan

1. Feature-flag B-root-only and inventory all active ticket worktrees, branches, checkpoints, ledgers, and review jobs.
2. Classify old records as terminal historical, stale, or human-review-required. Do not rewrite commits, infer ledger entries, or auto-release claims.
3. Remove runtime creation/use of ticket worktrees and integration/rebase code only after root-only commit, archive verification, review identity, recovery, and concurrency tests pass.
4. Update the immutable-pipeline plan and acceptance record to replace “reconstructed worktree” language with “root commit + archive materialization”.
5. Run a bounded shadow canary: dirty unrelated root file, two disjoint tickets, same-file claim conflict, crash after private-index preparation/ref advancement/index synchronization, post-commit root mutation, verification/review mismatch, and duplicate commit call. Require no accidental staging and exactly-once receipt persistence.
6. Replace worktree-era verification/review guards that require the ticket commit to equal live `HEAD` (`VERIFY_COMMIT_STALE`, `REVIEW_COMMIT_STALE`, the worktree clean-status assertion, and the integration-service worktree HEAD check); repoint verification `cwd` to the archive materialization; test ticket A's archive verification and review after a disjoint ticket B advances the root branch.

## Implementation notes for the coder

- `git archive` does not materialize submodules or LFS pointers the way a worktree checkout does. Before relying on archive materialization, check `.gitmodules` and `.gitattributes` (`filter=lfs`); if either exists in the repo, use or extend materialization accordingly and record the method in the artifact.
- The transaction-private index is implemented by setting `GIT_INDEX_FILE` to a temporary file for every `git` invocation inside the transaction — including any helper that shells out indirectly. A single invocation that misses the env var stages into the shared index and defeats the design. Prefer a small wrapper that injects the env var rather than threading it through call sites.
- The receipt journal record must carry an explicit `transaction_id` field, and the commit must carry `X-Ticket-Tx: <id>` as a trailer. Recovery matches on the trailer, never on the tree — two disjoint tickets can produce identical trees.
- Removing `VERIFY_COMMIT_STALE` / `REVIEW_COMMIT_STALE` does not mean removing the check. Replace each with an existence check: the recorded `commit_sha` must exist in the repository and be an ancestor of (or equal to) current `HEAD` — e.g. `git cat-file -e <sha>` plus `git merge-base --is-ancestor <sha> HEAD`. This still blocks verification against a GC'd or rewritten commit.
- Repointing verification `cwd`/`worktreeRoot` to the archive materialization touches `verification-plan-builder.js` and `command-executor.js` — read both first to find where relative paths are resolved, so no command silently runs against the mutable root.

## Required implementation evidence

- Root-only unit/integration tests prove no `git worktree` command is issued by ticket execution.
- A dirty unrelated path is absent from the ticket commit.
- The baseline-only transaction is rejected without a durable human approval receipt.
- Archive verification and Reviewer evidence identify the same commit/tree/manifest/artifact.
- Restart recovery neither duplicates a root commit nor loses a created receipt.
- A dirty manifest path is rejected until an approved baseline-only commit exists, while dirty unrelated paths stay outside the ticket commit.
- A crash in every commit phase leaves no unowned staged entries and either recovers a proven transaction or quarantines it.
- Ticket A's verification and review remain valid after a disjoint ticket B advances root `HEAD`.
- `git diff --check`, relevant backend/UI tests, schema validation when contracts change, and a real disposable repository witness pass before rollout.

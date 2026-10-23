# Plan — Ticket worktree commits with the project root as live source

## Decision

Coder and Reviewer read project files from the **project root**. Forge writes ticket code through the root File Service, so the existing watcher updates the single shared code index. A ticket Git worktree remains a real checkout and branch, but serves to reconstruct, verify, review, and commit only that ticket's recorded changes. Do not watch or index `.forge/worktrees/**`.

No file list is required before discovery. The ticket manifest starts empty; Forge adds a path only after its first authorized write. The existing role/path policy still decides whether a write is allowed. A manifest entry records what was actually changed; it does not grant permission to change another file.

## Current gap

- `ticket-workspace-service.js` binds ticket `fileService`, cache, freshness checker, test service, and Reviewer to the worktree, while `codeSearch` uses the project-root index. Worktree source and index can therefore disagree.
- `write_diff`/`edit_diff` currently remember changed paths in the in-memory execution context. A restart or new Coder session cannot use this as the authoritative ticket ledger.
- `commit_changes` commits those context paths through the worktree Git Service. The ticket worktree can contain code different from the project root; a worktree commit also does not advance the root branch.
- The project root already contains unrelated dirty files. A raw copy of a root file into a worktree could commit another task's edits. Path-only staging does not solve this.

## Data and ownership

Create one durable, project-scoped **ticket change ledger** under `.forge/runtime/` using the existing File Service and lock primitives. Store `project_id`, `task_id`, `supervisor_id`, workspace branch/base SHA, ledger revision, and entries keyed by canonical relative path. Each entry stores owner claim, file existence before first write, initial and latest content SHA, ordered write operation IDs, and references to the before/after snapshots or exact patches. Persist source snapshots outside prompts/logs; do not put code or secrets into project logs or SSE events. Bound storage and clean it according to the existing protected-path policy.

The ledger is created empty when the ticket is dispatched. A path is claimed **on the first successful Forge write attempt**, never from candidate files, search results, or a guessed ticket scope. Claim must be atomic across tickets and Control API workers, idempotent for a retry of the same operation, and retained across Coder retries, review/revision, checkpoints, and restart. Release only after the ticket's terminal policy has settled the changes; keep unresolved claims for `needs_human_review` until an explicit resolution. Reuse existing ticket and agent ownership IDs; do not create another ticket queue.

If another ticket owns the path, return a stable `FILE_CLAIM_CONFLICT` with owner ticket ID and retry guidance; do not wait while holding a File Service lock. A human or external process may still edit the project root, so every write and commit rechecks the live SHA. A file already dirty before the first claim is not silently adopted into the ticket: record its baseline and reconstruct only the ticket's subsequent before-to-after delta. If that delta cannot be isolated, stop with `TICKET_BASELINE_CONFLICT` and request explicit resolution rather than committing unrelated content.

## Write transaction

1. Keep `write_diff`/`edit_diff` schemas and existing authorization, protected-path, checksum, 250-line, and summary rules. Route ticket writes through a ticket-aware File Service wrapper; owner chat and other roles keep their existing route.
2. Under one cross-process lock for the canonical path, check ownership and current checksum, capture the before state, and journal a prepared operation with `task_id` and idempotency key. Reject conflicting owner or checksum before changing the root file.
3. Apply the write through the **root File Service**. Persist the after checksum and patch/snapshot, update the manifest, invalidate the root code cache, and publish only bounded metadata. The watcher continues to index the root through its existing path and event route.
4. Handle a crash between root write and ledger completion by replaying the prepared operation: compare live content with recorded before/after SHA, finalize idempotently if it matches, or quarantine the claim and stop on an unknown state. Never let a missing ledger entry make a completed root write appear unowned.
5. Use the same mechanism for ticket-owned create/delete/rename operations when such Forge write tools are enabled. A new file starts with `before_exists=false`; a delete records the removed content and a tombstone. All paths pass File Service and protected-path checks.

## Read, index, and verification

- Ticket Coder, Reviewer, `search_code`, `read_file`, `Read`, `sed_lines`, cache, graph freshness checker, and test service use the project root for source and the existing root index. No per-ticket index DB or second watcher.
- After a root write, the tool may return before the asynchronous indexer completes. Search results must expose `indexed_sha256` versus live `content_sha256` and `index_status`; stale symbol ranges must be resolved against live content or rejected. A test must prove the agent cannot silently use a stale range. Do not claim the watcher has caught up merely because the write succeeded.
- Run ticket verification against the root with its current live contents. For tests that require ticket isolation, also verify the reconstructed ticket worktree before commit. Record which environment each result came from; concurrent changes on disjoint files can still affect root tests.
- Reviewer receives the committed ticket diff and may read root source, but the review evidence must identify any root content that has advanced beyond the reviewed commit. A later root change must not silently change what was approved.

## Reconstruct, commit, and integrate

1. `commit_changes` loads the durable ledger, not `context.changed_paths`, and locks its revision. Check that each claimed root file still matches the latest recorded SHA. Reject an unexpected edit or a path not authorized by the existing role policy.
2. In the ticket worktree, apply **only recorded ticket deltas** from each entry's before/after states. Never copy whole root files as a shortcut. Check the worktree baseline and use a bounded three-way application when its branch differs from the root pre-write state; fail closed on overlap. Existing worktree content outside ledger paths is not staged.
3. Compare the worktree diff against the ledger paths and expected after hashes, then call Git Service with literal pathspecs. Commit exactly those paths. Persist commit SHA and ledger revision before returning tool success. A repeated `commit_changes` for the same revision returns the existing SHA; a Reviewer-requested revision produces a new ledger revision and a subsequent commit.
4. Keep the ticket branch and root Git history coherent. An approved ticket commit must be integrated into the root branch through a serialized **integration gate** before its file claims are released. A worktree commit alone is not acceptance or integration. The gate checks commit ancestry, the root branch/index, every touched root file SHA, and concurrent claims. If the ticket branch is behind, replay/rebase its ticket-only commits on the current integration HEAD in the worktree; stop on conflict. Never reset, stash, or overwrite other root changes.
5. Integration must account for the fact that the root worktree already contains the approved file bytes. Implement a recoverable Git transaction that advances the root branch/index to the reviewed tree only after comparing those bytes, while preserving unrelated unstaged edits. Journal the pre/post HEAD and index state; recover after a crash. If the index has unrelated staged changes or the operation cannot preserve them, stop with `TICKET_INTEGRATION_CONFLICT`. Do not treat a successful worktree commit as a successful root integration.
6. Maintain one authoritative integration HEAD for new ticket branches. Tickets already running may retain older bases, but must reconcile against the latest integration HEAD before their commits are integrated. Keep the existing checkpoint and review-only routes tied to the same ledger and branch.

## Implementation slices

| Slice | Change | Evidence |
| --- | --- | --- |
| 1. Durable ledger and claims | Add File Service-backed journal/manifest, cross-process per-path ownership, operation idempotency, and recovery. | Two tickets racing on one path yield one owner; restart preserves it; duplicate write does not duplicate a patch. |
| 2. Root-bound ticket tools | Rewire Supervisor ticket registry, Coder, Reviewer, cache, freshness, and tests to root source; retain worktree Git Service for reconstruction/commit. | Agent read/write sees root; watcher index SHA catches up; no worktree index activity. |
| 3. Ticket write wrapper | Connect all ticket Forge mutations to the ledger transaction and root File Service; remove in-memory changed-path authority. | Create/edit/delete, failed write, crash between write and ledger finalize, external edit, and protected path tests. |
| 4. Commit reconstruction | Replay only ticket deltas in worktree, validate diff and path list, commit idempotently. | Two dirty but disjoint root tickets produce separate commits; pre-existing dirty content is excluded. |
| 5. Integration and review | Serialize approved commit integration into root branch, preserve unrelated root edits, and feed Reviewer exact committed diff. | Approval advances authoritative HEAD once; rejected review/revision keeps claim; integration conflict never marks accepted. |
| 6. Migration | Detect existing ticket worktrees and checkpoints; compare their commits and root contents with the new ledger. | Existing `NF-UI-CONV-003` and `TICKET-PROJECT-NODEFORGE-1790660105591` are classified without auto-claiming or rewriting their history. |

## Superseding immutable-evidence gate

This plan selects root-as-live-source, but its previous root-read/root-verify wording is insufficient as an acceptance contract. The binding implementation and rollout plan is `workflows/plan-immutable-ticket-pipeline.md`.

Until `NF-PIPE-CTX-001`, `NF-PIPE-VERIFY-002`, and `NF-PIPE-REV-003` there are accepted, root source, ledger snapshot, reconstructed worktree commit, verification result, and Reviewer evidence **must not** be treated as interchangeable. In particular:

- verification may not pass solely because individual `changed_paths` verify or because an in-memory test job passed;
- a Reviewer may not approve a mutable root/cache view as proof for a worktree commit;
- `report_done`, review dispatch, approval, integration, and claim release require the matching persisted context, manifest, commit, and durable verification artifact;
- any mismatch, unavailable exact materialization, or post-verification drift fails closed to `request_changes`, `blocked`, or `needs_human_review`.

The ledger continues to define ticket-owned deltas, but the Supervisor-owned immutable execution context defines the revision identity and the final manifest. Agent-provided changed paths remain advisory and cannot reduce verification coverage.

## Acceptance gates

1. Run two tickets on disjoint files concurrently: root watcher indexes both; each ticket worktree contains and commits only its own changes; approval integrates each once.
2. Run two tickets on the same file: the second cannot write until the first claim is settled; it then starts from the integrated content and fresh index.
3. Start with an unrelated dirty root file, including a dirty file later touched by a ticket: unrelated pre-existing bytes never enter that ticket's commit without explicit reconciliation.
4. Exercise Coder timeout/resume, Reviewer rejection/revision, duplicate tool calls, Control API restart, and crash recovery at every write/commit/integration boundary.
5. Verify source/index SHA transitions (`stale` then `fresh`), no second watcher/index DB, and no raw code in audit/SSE logs.
6. Run focused unit/integration tests, relevant UI/backend build or typecheck, schema validation if contracts change, and `git diff --check`. Record command results in the implementation report. Do not declare a ticket accepted on worktree commit alone.

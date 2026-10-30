# Plan — Unify root-only workspace integration with the terminal receipt contract

## Decision

Root-only `workspace.integrate()` must emit the same durable terminal-integration
receipt as the legacy worktree path — a file at
`.forge/runtime/ticket-integrations/{taskId}.json` with schema
`{ task_id, branch, previous_head, reviewed_commit, commit, status }`,
a two-phase `prepared → completed` lifecycle, and idempotent
`{ repeated: true }` on re-entry. Downstream gates (Phase B, resume probes,
multi-agent claim release) must be able to query one receipt contract
regardless of which workspace mode produced it.

## Why unify now

- **Downstream consumers only check for file existence and `reviewed_commit`.**
  If the root-only path "completes" without writing a receipt, the Phase B
  probe, resume logic, and ticket-supervisor reports all lose their evidence
  even though the commit is real on root HEAD.
- **`repeated: true` idempotency solves the double-completion problem.** In a
  multi-agent setup, two supervisors may both believe they own the final
  integrate step (retry after conflict, resume after crash). The contract
  "load previous → if completed + commit is ancestor → return repeated" is the
  same dedupe pattern `agent.request` dedupe and the claim queue will reuse.
- **The two-phase `prepared → completed` shape is the model for every
  non-terminal state written later.** `FILE_CLAIM_WAITING` in the new plan
  also needs "record intent first, confirm later, re-read on resume" —
  unifying the receipt path now means resume logic learns one pattern.
- **Escalations like `claim_queue_corrupt` / `claim_wait_timeout` need durable
  evidence** a human can inspect with `cat`, without loading execution
  context.

## Current gap

`ticket-root-workspace.js:openOnce` (~line 93) returns a workspace whose
`integrate()` only verifies:

```js
integrate: async () => {
  const artifact = await testService.assertPassedArtifact();
  await rootGit.assertAncestor(artifact.commit_sha);
  return { sha: artifact.commit_sha, repeated: true };
}
```

The root-only commit is already on root HEAD the moment it is created (no
update-ref step), so `integrate()` is verify-only — it writes no receipt, and
any probe waiting on the file fails.

## Changes

### 1. New module `backend/src/modules/supervisor/terminal-receipt-writer.js` (~60 lines)

Extract a shared writer used by both workspace modes:

```js
// Write/read the terminal integration receipt for a ticket.
// Used by both worktree and root-only integration paths so that downstream
// gates (Phase B, resume, multi-agent claim release) query a single durable
// artifact regardless of workspace mode.
export function createTerminalReceiptWriter({ fileService, projectLogger = () => {} }) {
  const STATE = ".forge/runtime/ticket-integrations";
  const path = (taskId) => `${STATE}/${taskId}.json`;
  return Object.freeze({ path, load, savePrepared, saveCompleted, loadIfCompleted });
}
```

API:
- `load(taskId)` → receipt object or null (ENOENT → null)
- `savePrepared(taskId, receipt)` → write `status: "prepared"`
- `saveCompleted(taskId, receipt)` → write `status: "completed"`
- `loadIfCompleted(taskId)` → receipt only if `status === "completed"`
  (used for idempotency and the Phase B gate)

Schema (additive, backward-compatible):

```js
{
  task_id, branch, previous_head, reviewed_commit, commit, status,
  workspace_mode: "root-only" | "worktree",
  supervisor_id: string | null,   // optional; multi-agent forensic
  recorded_at: ISO string
}
```

`supervisor_id` is the one additive field for multi-agent: if two supervisors
ever write a receipt for the same taskId (should not happen, but guard against
corruption), the field supports forensic. It stays `null` until a caller
passes one.

### 2. Refactor `ticket-integration-service.js`

Inject `receiptWriter` (fallback: construct one from `fileService` if not
provided). Replace the internal `statePath`/`save` calls with
`receiptWriter.path` / `savePrepared` / `saveCompleted` / `load`. Keep all git
logic unchanged — only persistence moves. Add `workspace_mode: "worktree"`
to the emitted receipt.

### 3. Wire `integrate` in `ticket-root-workspace.js`

```js
integrate: async () => {
  const artifact = await testService.assertPassedArtifact();
  const head = (await git.getHead()).trim();          // git = rootGit's gitService
  const branch = await rootGit.checkedBranch();
  const prior = await receiptWriter.load(taskId);
  if (prior?.status === "completed") {
    await rootGit.assertAncestor(prior.commit);
    return { sha: prior.commit, repeated: true };
  }
  if (prior?.status === "prepared") {
    // prepared only exists after a crash between the two phases; root-only
    // needs no rollback because the commit is already on HEAD — verify and
    // flip to completed.
    await rootGit.assertAncestor(artifact.commit_sha);
    await receiptWriter.saveCompleted(taskId, prior);
    return { sha: prior.commit, recovered: true };
  }
  const state = {
    task_id: taskId, branch, previous_head: head,
    reviewed_commit: artifact.commit_sha, commit: artifact.commit_sha,
    workspace_mode: "root-only", supervisor_id: null,
    status: "prepared", recorded_at: new Date().toISOString(),
  };
  await receiptWriter.savePrepared(taskId, state);
  await rootGit.assertAncestor(artifact.commit_sha);   // "integration" = verify
  await receiptWriter.saveCompleted(taskId, state);
  projectLogger({ event_name: "ticket.integration_completed", ... });
  return { sha: artifact.commit_sha };
}
```

Note: `previous_head` for root-only = HEAD **at integrate time** — different
from legacy (HEAD *before* update-ref) because root-only has no update-ref.
Document this semantic difference in the code comment.

### 4. `ticket-workspace-service.js`

Create one shared
`receiptWriter = createTerminalReceiptWriter({ fileService: stateFileService, projectLogger })`
inside `createTicketWorkspaceService` and pass it to both
`createTicketIntegrationService` (legacy) and `createTicketRootWorkspace`
(root-only), so both paths use the same instance and path.

### 5. Tests

- Extend `backend/tests/integration/ticket-workspace-service.test.js` or add
  `ticket-root-terminal-receipt.test.js`:
  - After root-only `workspace.integrate()`, the file
    `.forge/runtime/ticket-integrations/{taskId}.json` exists with
    `status: "completed"`, `workspace_mode: "root-only"`, and
    `reviewed_commit === commit === artifact.commit_sha`.
  - Second `integrate()` returns `{ repeated: true }`; receipt unchanged.
  - Seed a `status: "prepared"` receipt to simulate crash → `integrate()`
    returns `{ recovered: true }` and flips to `completed`.
  - `branch` in the receipt matches `rootGit.checkedBranch()` at integrate
    time.
- `control-api-real-provider-witness.test.js` (root-only mode): the probe reads
  the receipt with no changes needed — path and `reviewed_commit` contract
  preserved.

## Implementation order

1. Create `terminal-receipt-writer.js` + unit test for the writer.
2. Refactor `ticket-integration-service.js` to use the writer (no behavior
   change; existing tests keep passing).
3. Wire into `ticket-root-workspace.js` and `ticket-workspace-service.js`.
4. Add the root-only receipt integration test.
5. Run `ticket-workspace-service.test.js`,
   `immutable-ticket-pipeline.test.js`, `ticket-root-workspace.test.js`, and
   `root-coder-provider-evidence.js` — the root-only witness probe should pass.

## Risks and open questions

- **`previous_head` semantics differ between modes.** Legacy = HEAD before the
  ref move; root-only = HEAD at integrate time (the commit's parent if the
  commit was just created, or the commit itself if already an ancestor). If any
  Phase B/consumer uses `previous_head` to roll back, root-only cannot roll
  back that way — document clearly that "root-only commit is already on HEAD;
  rollback = revert commit, not reset ref."
- **`branch` field format**: root-only `checkedBranch()` returns
  `refs/heads/...`; legacy `git branch --show-current` returns a short name.
  Normalize to one format (proposal: short name for both, or add a separate
  `branch_ref` field).
- **`supervisor_id`**: no caller passes it yet — keep `null` in the schema and
  add the parameter when multi-agent wiring needs it.

## Estimate

~3 files modified + 1 new module + 1 test file. No complex git plumbing —
mostly extract + wire.

// Verifies Coder publishes only its latest recorded ticket commit without invoking real remote Git.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketPushTool } from "../../src/tools/reporting/ticket-push-tool.js";

test("ticket push accepts its latest ledger commit and delegates Git safety checks", async () => {
  const sha = "a".repeat(40);
  const calls = [];
  const tool = createTicketPushTool({
    changeLedger: { snapshot: async (id) => { assert.equal(id, "T"); return { revision: 2, commits: { 2: sha } }; } },
    executionContexts: { load: async () => ({ review_commit_sha: sha }) },
    gitService: { pushCommit: async (value) => { calls.push(value); return { sha: value }; } }
  });
  assert.deepEqual(await tool.execute({ commit_sha: sha }, { task_id: "T" }), { sha });
  await assert.rejects(tool.execute({ commit_sha: "b".repeat(40) }, { task_id: "T" }), { code: "PUSH_COMMIT_SCOPE_INVALID" });
  assert.deepEqual(calls, [sha]);
});

test("ticket push refuses uncommitted changes, absent receipts and mismatched execution identity", async () => {
  const sha = "a".repeat(40);
  for (const [ledger, execution] of [
    [{ revision: 3, commits: { 2: sha } }, { review_commit_sha: sha }],
    [{ revision: 2, commits: {} }, { review_commit_sha: sha }],
    [{ revision: 2, commits: { 2: sha } }, { review_commit_sha: "b".repeat(40) }]
  ]) {
    const tool = createTicketPushTool({ changeLedger: { snapshot: async () => ledger }, executionContexts: { load: async () => execution },
      gitService: { pushCommit: async () => assert.fail("Out-of-scope push reached Git") } });
    await assert.rejects(tool.execute({ commit_sha: sha }, { task_id: "T" }), { code: "PUSH_COMMIT_SCOPE_INVALID" });
  }
});

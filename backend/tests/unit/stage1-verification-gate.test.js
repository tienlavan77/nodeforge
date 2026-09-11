import assert from "node:assert/strict";
import test from "node:test";
import { createStage1VerificationGate } from "../../src/modules/workflows/stage1-verification-gate.js";

const base = { taskId: "TASK-VERIFY-1", projectId: "PROJECT-NODEFORGE", commitId: "abc123", branch: "task/TASK-VERIFY-1", target: "main", filesChanged: ["ui/nextjs/app/page.jsx"] };

test("merges only after verification passes", async () => {
  const calls = [];
  let current = { status: "reviewing" };
  const gate = createStage1VerificationGate({ verificationOrchestrator: { run: async () => ({ status: "passed", ready_for_review: true, commit_id: "abc123", run_id: "run-1" }) }, gitService: { merge: async (...args) => { calls.push(args); return { target: "main" }; } }, statusStore: { updateStatus: (_id, next) => { current = { status: next }; return current; } } });
  const result = await gate.verifyAndMerge(base);
  assert.equal(result.merged, true);
  assert.equal(current.status, "done");
  assert.deepEqual(calls[0], [base.branch, { target: base.target, noFastForward: true }]);
});

test("does not merge a failed verification", async () => {
  let merges = 0;
  const gate = createStage1VerificationGate({ verificationOrchestrator: { run: async () => ({ status: "failed", ready_for_review: false, commit_id: "abc123", run_id: "run-2" }) }, gitService: { merge: async () => { merges += 1; } } });
  const result = await gate.verifyAndMerge(base);
  assert.equal(result.status, "verification_failed");
  assert.equal(result.merged, false);
  assert.equal(merges, 0);
});

test("aborts and escalates merge conflicts", async () => {
  let aborted = 0;
  let current = { status: "reviewing" };
  const gate = createStage1VerificationGate({ verificationOrchestrator: { run: async () => ({ status: "passed", ready_for_review: true, commit_id: "abc123", run_id: "run-3" }) }, gitService: { merge: async () => { const error = new Error("conflict"); error.code = "GIT_MERGE_CONFLICT"; throw error; }, abortMerge: async () => { aborted += 1; } }, statusStore: { updateStatus: (_id, next) => { current = { status: next }; return current; } } });
  const result = await gate.verifyAndMerge(base);
  assert.equal(result.status, "merge_conflict");
  assert.equal(aborted, 1);
  assert.equal(current.status, "needs_human_review");
});

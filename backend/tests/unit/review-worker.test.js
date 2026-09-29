// Verifies that independent review uses bounded Forge source evidence and strict verdicts.
import assert from "node:assert/strict";
import test from "node:test";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

// Supplies a read-only Reviewer and captures the prompt sent through the SDK.
function harness({ text = '{"verdict":"approved","findings":[]}', sourceSize = 12, staleOnSecondRead = false, patch = "" } = {}) {
  const calls = [];
  const events = [];
  let reads = 0;
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", agent_name: "Leader", provider: "openai", role: "reviewer" }) },
    openaiSdkGateway: { execute: async (input) => { calls.push(input); return { text }; } },
    fileService: { readForIndex: async ({ path, maxBytes }) => ({ path, sha256: staleOnSecondRead && ++reads > 1 ? "sha256:changed" : "sha256:abc", size_bytes: sourceSize, content: path === "workflows/agents/reviewer.md" ? "Reviewer rules: inspect evidence and return a verdict." : "const ok = true;", maxBytes }) },
    gitService: { diffPatchFrom: async () => patch },
    projectRoot: "/project",
    projectLogger: (entry) => events.push(entry)
  });
  return { worker, calls, events };
}

test("independent Reviewer approves only an explicit structured verdict", async () => {
  const { worker, calls, events } = harness({ patch: "diff --git a/src/a.js b/src/a.js" });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1", acceptance_criteria: ["Works"] }, changed_paths: ["src/a.js"], base_commit: "abc123", verification: { status: "passed" } } });
  assert.equal(result.verdict, "approved");
  assert.equal(result.reviewer_id, "reviewer-1");
  assert.match(calls[0].prompt, /const ok = true/);
  assert.match(calls[0].prompt, /Works/);
  assert.match(calls[0].prompt, /diff --git/);
  assert.match(calls[0].prompt, /Reviewer rules: inspect evidence/);
  for (const event of events.filter(({ event_name }) => event_name.startsWith("review."))) assert.equal(event.payload.agent_name, "Leader");
});

test("approval is rejected when source changes while the Reviewer is reading", async () => {
  const { worker } = harness({ staleOnSecondRead: true });
  await assert.rejects(() => worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } }), (error) => error.code === "REVIEW_EVIDENCE_STALE");
});

test("free-form or unsupported review evidence cannot approve a ticket", async () => {
  const { worker } = harness({ text: "looks good" });
  const job = { task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } };
  await assert.rejects(() => worker.review(job), (error) => error.code === "REVIEW_VERDICT_INVALID");
  await assert.rejects(() => worker.review({ ...job, payload: { ...job.payload, changed_paths: [] } }), (error) => error.code === "REVIEW_EVIDENCE_INVALID");
});

test("accepts a JSON verdict wrapped in reviewer prose", async () => {
  const { worker } = harness({ text: "I'll review the supplied evidence.\n\n{\"verdict\":\"approved\",\"findings\":[]}\n\nReview complete." });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(result.verdict, "approved");
});

test("selects the valid verdict object when response contains another malformed object", async () => {
  const { worker } = harness({ text: "Tool note: {invalid}\nFinal: {\"verdict\":\"approved\",\"findings\":[]}" });
  const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, changed_paths: ["src/a.js"] } });
  assert.equal(result.verdict, "approved");
});

// Verifies malformed Reviewer guidance stays a review fault instead of becoming a Coder repair.
import assert from "node:assert/strict";
import test from "node:test";
import { assertReviewFindingGuidance } from "../../src/modules/supervisor/review-finding-guidance.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { createReviewRequestHandler } from "../../src/modules/supervisor/review-request-handler.js";
import { assertCachedReviewResult } from "../../src/modules/supervisor/recovery-evidence.js";

const finding = { failure: "Click does not close the dialog", acceptance_criterion: "Dialog closes on click",
  evidence_refs: ["src/dialog.js:12"], minimum_change_scope: "Fix the close handler without changing the contract" };

test("canonical guidance is accepted for strict and compatibility reviews", () => {
  for (const strict of [false, true]) assert.doesNotThrow(() => assertReviewFindingGuidance({ findings: [finding], adjudications: [] }, { strict }));
});

test("legacy prose, blank evidence and missing fix guidance require Reviewer re-review", () => {
  for (const strict of [false, true]) {
    for (const invalid of ["Fix it", null, { ...finding, failure: 42 }, { ...finding, evidence_refs: [""] },
      { ...finding, evidence_refs: [] }, { ...finding, minimum_change_scope: " " }, { ...finding, acceptance_criterion: undefined },
      { ...finding, files: ["a", "b"], per_file_necessity: [{ path: "a", role: "handler" }, { path: "a", role: "test" }] }]) {
      assert.throws(() => assertReviewFindingGuidance({ findings: [invalid], adjudications: [] }, { strict }), { code: "REVIEW_VERDICT_INVALID" });
    }
  }
  assert.throws(() => assertReviewFindingGuidance({ findings: [], adjudications: [null] }), { code: "REVIEW_VERDICT_INVALID" });
});

test("legacy string from the real review parser produces review.failed, never request_changes", async () => {
  const events = [];
  const worker = createReviewWorker({ projectRoot: "/project", agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer", provider: "openai" }) },
    openaiSdkGateway: { execute: async () => ({ text: JSON.stringify({ verdict: "request_changes", findings: ["Fix it"] }) }) },
    fileService: { readForIndex: async ({ path }) => ({ path, sha256: "sha256:1", content: "source and rules", size_bytes: 16 }) } });
  const handler = createReviewRequestHandler({ reviewWorker: worker, queueStore: { save: async () => {} }, queue: { ack: async () => {} }, eventBus: { publish: async (event) => events.push(event) } });
  const result = await handler({ task_id: "TASK", request_id: "REVIEW", agent_id: "coder", payload: { changed_paths: ["src/dialog.js"] } });
  assert.equal(result.type, "review.failed");
  assert.equal(result.payload.error.code, "REVIEW_VERDICT_INVALID");
  assert.equal(events.length, 1);
});

test("cached legacy findings cannot bypass a fresh Reviewer guidance check", () => {
  assert.throws(() => assertCachedReviewResult({ review_result: { payload: { findings: ["Fix it"] } } }),
    (error) => error.code === "EXECUTION_RECONCILIATION_CONFLICT" && /re-review/.test(error.message));
});

test("unrelated reference cannot masquerade as a source location", () => {
  assert.throws(() => assertReviewFindingGuidance({ findings: [{ ...finding, evidence_refs: ["Trust me"] }] }, { paths: ["src/dialog.js"] }), { code: "REVIEW_VERDICT_INVALID" });
  assert.doesNotThrow(() => assertReviewFindingGuidance({ findings: [finding] }, { paths: ["src/dialog.js"] }));
});

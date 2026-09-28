// Verifies Reviewer jobs share agent.request and retry without another SDK verdict.
import assert from "node:assert/strict";
import test from "node:test";
import { createReviewRequestHandler } from "../../src/modules/supervisor/review-request-handler.js";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";

test("review job persists one verdict in agent.request before publishing and acknowledging", async () => {
  const order = [];
  let calls = 0;
  const handler = createReviewRequestHandler({
    reviewWorker: { review: async () => { calls += 1; return { verdict: "approved", reviewer_id: "reviewer-1", findings: [] }; } },
    queueStore: { save: async (queue, job) => { order.push(["save", queue]); assert.equal(job.review_result.type, "review.approved"); } },
    queue: { ack: async () => { order.push(["ack"]); } },
    eventBus: { publish: async (event) => { order.push(["publish"]); assert.equal(event.type, "review.approved"); } }
  });
  const job = { id: "JOB-1", operation: "review", role: "reviewer", task_id: "TASK-1", supervisor_id: "SUP-1", request_id: "REVIEW-REQ-1", correlation_id: "CORR-1", attempt: 1, agent_id: "coder-1", payload: {} };
  await handler(job);
  await handler({ ...job, review_result: { type: "review.approved", payload: { verdict: "approved", reviewer_id: "reviewer-1", findings: [] } } });
  assert.equal(calls, 1);
  assert.deepEqual(order.slice(0, 3), [["save", "agent.request"], ["publish"], ["ack"]]);
});

test("Sender Worker dispatches review jobs from agent.request to the review handler", async () => {
  const job = { id: "JOB-REVIEW", operation: "review", request_id: "REQ-REVIEW" };
  let handled = 0;
  const worker = createSenderWorker({
    queue: { claim: async () => job },
    agentRegistry: { resolve: () => { throw new Error("Coder adapter must not receive review jobs."); } },
    eventBus: { publish: async () => { throw new Error("Review handler owns event publication."); } },
    reviewHandler: async (claimed) => { assert.equal(claimed, job); handled += 1; return { type: "review.approved" }; }
  });
  assert.deepEqual(await worker.processOnce(), { type: "review.approved" });
  assert.equal(handled, 1);
});

// Verifies independent review persists its verdict and makes the ticket status usable by the Sprint DAG.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { ensureReviewStatusReady } from "../../src/modules/supervisor/review-only-status.js";

test("review-only saves an approved checkpoint before publishing the terminal outcome", async () => {
  const events = [];
  const updates = [];
  const reviewer = { agent_id: "reviewer-1", agent_name: "Leader", provider: "claude", role: "reviewer", enabled: true, status: "ready" };
  let status;
  let saved;
  const ticketStatusStore = {
    get: () => status ? { status } : undefined,
    create: () => { status = "pending"; updates.push(status); },
    updateStatus: (_taskId, next) => { status = next; updates.push(status); }
  };
  const integration = createNodeforgeTaskIntegration({
    supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async (event) => { assert.equal(saved?.verdict, "approved"); events.push(event); } },
    agentResolver: { resolveAvailable: () => reviewer, list: () => [reviewer] },
    agentOccupancy: { claim: async () => ({ claim_id: "CLAIM-1", agent_id: reviewer.agent_id }), release: async () => {} },
    ticketStatusStore,
    handoffQueue: { enqueue: async () => ({}) },
    claudeSdkGateway: { execute: async () => ({ text: '{"verdict":"approved","findings":[]}' }) },
    fileService: { readForIndex: async ({ path }) => ({ path, content: path.endsWith("reviewer.md") ? "Review source." : "const ready = true;", sha256: "sha256:abc", size_bytes: 20 }) },
    gitService: { getHead: async () => "HEAD-1", diffPatchFrom: async () => "" },
    checkpointStore: { loadReview: async () => ({ review_attempt: 1, verdict: "request_changes" }), completeReview: async (_taskId, details) => { saved = details; return details; } },
    projectRoot: "/project"
  });
  const result = await integration.reviewOnly({ ticket: { id: "TICKET-1", project_id: "PROJECT-1" }, commit: "HEAD-1", changed_paths: ["src/a.js"] });
  assert.equal(result.verdict, "approved");
  assert.equal(saved.review_attempt, 2);
  assert.deepEqual(saved.changed_paths, ["src/a.js"]);
  assert.deepEqual(updates, ["pending", "running", "reviewing"]);
  assert.equal(events[0].type, "task.completed");
});

test("an already completed ticket needs no extra status transition", () => {
  const ticketStatusStore = { get: () => ({ status: "done" }), create: () => { throw new Error("unexpected create"); }, updateStatus: () => { throw new Error("unexpected update"); } };
  ensureReviewStatusReady(ticketStatusStore, "TICKET-1");
});

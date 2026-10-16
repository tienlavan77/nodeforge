// Verifies actual SDK and sender boundaries retain recovery evidence without early terminal publication.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";

test("inline SDK exception returns recovery pending instead of throwing into RUN terminal handling", async () => {
  const failure = Object.assign(new Error("Temporarily unavailable"), { code: "SERVICE_UNAVAILABLE", provider_outcome: "failed", retry_safe: true });
  const decisions = [];
  let checkpoint;
  const integration = createNodeforgeTaskIntegration({ projectRoot: process.cwd(), supervisorManager: { startTask: async () => ({}) },
    eventBus: { publish: async () => assert.fail("No early terminal event") },
    agentResolver: { resolveAvailable: () => ({ agent_id: "CODER", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB" }) }, toolRegistry: { report_done: { execute: async () => ({}) } },
    checkpointStore: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
    runtimeGovernance: { createExecutionContext: (input) => input }, codexSdkGateway: { execute: async () => { throw failure; } },
    coderRecovery: { handleFailure: async (input) => { decisions.push(input); return { handled: true, outcome: "pending" }; } } });
  const result = await integration.submitTicket({ ticket: { id: "TASK", project_id: "PROJECT", title: "Fix handler", objective: "Fix handler", acceptance_criteria: ["Handler works"] }, request_id: "REQ" });
  assert.equal(result.status, "recovery_pending");
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].error, failure);
  assert.equal(decisions[0].source, "sdk_exception");
  assert.equal(decisions[0].request.request_id, "REQ");
  assert.equal(checkpoint.status, "in_progress");
  assert.equal(checkpoint.phase, "operational_retry_pending");
});

test("sender failure event preserves structured safety evidence, not just SDK error prose", async () => {
  const events = [];
  let acknowledgements = 0;
  const worker = createSenderWorker({ queue: { claim: async () => ({ id: "JOB", task_id: "TASK", request_id: "REQ", payload: {} }), ack: async () => { acknowledgements += 1; } },
    agentRegistry: { resolve: () => ({ adapter: { send: async () => { throw Object.assign(new Error("SDK unavailable"), {
      code: "CONFIGURATION_ERROR", cause: { code: "ECONNRESET" }, provider_outcome: "failed", retry_safe: true }); } } }) },
    eventBus: { publish: async (event) => events.push(event) } });
  await worker.processOnce();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "agent.response.failed");
  assert.equal(events[0].payload.error.cause.code, "ECONNRESET");
  assert.equal(events[0].payload.error.provider_outcome, "failed");
  assert.equal(events[0].payload.error.retry_safe, true);
  assert.equal(acknowledgements, 1);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";
import { createSupervisorRoundController } from "../../src/modules/supervisor/round-controller.js";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

function runtimeStub(state = "WAITING_AGENT") {
  const transitions = [];
  return { transitions, state: () => state, async transition(next) { transitions.push([state, next]); state = next; } };
}

test("material verification failure opens a persisted repair round via the round controller", async () => {
  const sent = [];
  const controller = createSupervisorRoundController({
    requestBuilder: createStage1TaskRequestBuilder(),
    conversationId: "CONV-REPAIR",
    executionContextProvider: ({ round }) => ({ task_id: "TASK-RP", execution_id: `SUP:${round}`, agent_identity: { agent_id: "builder", role: "builder" }, capabilities: [], allowed_resources: {}, audit_context: {} }),
    contextProvider: async () => [{ path: "a.js", exists: true, before_checksum: `sha256:${"a".repeat(64)}`, language: "javascript", size_bytes: 10, content: { type: "x" } }],
    fullContextProvider: async () => [{ path: "a.js", exists: true, before_checksum: `sha256:${"a".repeat(64)}`, language: "javascript", size_bytes: 10, content: "const a=1;" }]
  });
  let request = await controller.start({ task_id: "TASK-RP", project_id: "P", title: "T", objective: "O", acceptance_criteria: ["A"], agent_id: "builder", correlation_id: "CORR-RP" });
  request = (await controller.onResponse({ event: { task_id: "TASK-RP", request_id: request.request_id, correlation_id: "CORR-RP", attempt: 1 }, response: { type: "code_needed", files_requested: ["a.js"] } })).request;
  request = (await controller.onResponse({ event: { task_id: "TASK-RP", request_id: request.request_id, correlation_id: "CORR-RP", attempt: 1 }, response: { type: "planning", plan: [{ path: "a.js", action: "MODIFY", reason: "change" }] } })).request;
  const runtime = runtimeStub("VERIFYING");
  const loop = createSupervisorLoop({ runtime, senderQueue: { enqueue: async (job) => sent.push(job) }, materializerQueue: { enqueue: async () => {} }, verificationQueue: { enqueue: async () => {} }, eventBus: { publish: async () => {} }, roundController: controller });
  const result = await loop.onEvent({ type: "material_verification.completed", task_id: "TASK-RP", supervisor_id: runtime.supervisorId, request_id: request.request_id, correlation_id: "CORR-RP", attempt: 1, payload: { valid: {}, invalid: { "a.js": { path: "a.js", format: "structured_patch", current_content: "const a=1;", before_checksum: `sha256:${"a".repeat(64)}`, language: "javascript", size_bytes: 10 } } } });
  assert.equal(result.handled, true);
  assert.equal(controller.getRound(), 4);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.step_id, 4);
  assert.equal(sent[0].payload.type, "code_provide");
  assert.equal(sent[0].payload.expected_output.type, "submit_code_response");
  assert.ok(sent[0].payload.files?.length === 1);
  assert.equal(sent[0].payload.instruction_blocks.some((block) => block.block_id === "repair-correction"), true);
  // REPAIRING -> REQUESTING -> WAITING_AGENT is now a legal path
  assert.deepEqual(runtime.transitions.some(([from, to]) => from === "REPAIRING" && to === "REQUESTING"), true);
  // A repair response materializes without a new R3-style request
  const next = await controller.onResponse({ event: { task_id: "TASK-RP", request_id: sent[0].request_id, correlation_id: "CORR-RP", attempt: 2 }, response: { type: "submit_code_response", files: [{ path: "a.js", format: "structured_patch", exists: true, before_checksum: `sha256:${"a".repeat(64)}`, content: { operations: [{ op: "insert_at_end", new_content: "const b=2;" }] } }] } });
  assert.equal(next.materialize, true);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createStage1TaskRequestBuilder } from "../../src/modules/workflows/stage1-task-request-builder.js";

const ticket = { id: "FORGE-STAGE1-001", project_id: "PROJECT-STAGE1", title: "Create marker", objective: "Create one marker file.", acceptance_criteria: ["The marker exists."] };
const requestId = "11111111-1111-4111-8111-111111111111";

test("builds and validates canonical Node task envelope for OpenAI stage 1", () => {
  const builder = createStage1TaskRequestBuilder({ createRequestId: () => requestId, clock: () => new Date("2026-08-31T10:00:00.000Z"), conventions: ["Use File Service."] });
  const result = builder.buildTaskRequest(ticket, { agentId: "openai-coder" });
  assert.equal(result.type, "task");
  assert.equal(result.role, "node");
  assert.equal(result.request_id, requestId);
  assert.equal(result.payload.expected_submission, undefined);
  assert.equal(result.payload.instruction_blocks.some((block) => block.block_id === "task-review"), true); assert.equal(result.payload.instruction_blocks.some((block) => block.block_id === "planning"), false); assert.equal(result.payload.user_blocks.some((block) => block.block_id === "planning"), false);
  assert.equal(result.payload.metadata.project_id, ticket.project_id);
  assert.match(result.payload.user_blocks[0].content, /Create marker/);
});

test("rejects incomplete tickets before creating a request", () => {
  const builder = createStage1TaskRequestBuilder({ createRequestId: () => requestId });
  assert.throws(() => builder.buildTaskRequest({ ...ticket, acceptance_criteria: [] }), /acceptance_criteria/);
});


test("selects the requested submission representation and guidance", () => {
  const builder = createStage1TaskRequestBuilder({ createRequestId: () => requestId });
  const result = builder.buildTaskRequest(ticket, { agentId: "openai-coder", submissionFormat: "unified_diff", stepId: 2 });
  assert.equal(result.payload.expected_output.representation, "json");
  assert.match(result.payload.instruction_blocks[0].content, /NodeForge Code Index/); assert.doesNotMatch(result.payload.instruction_blocks[0].content, /ranged @@/);
});

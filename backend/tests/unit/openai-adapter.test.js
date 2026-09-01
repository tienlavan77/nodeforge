import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAIAdapter } from "../../src/modules/agent/provider-adapters/openai-adapter.js";

const requestId = "11111111-1111-4111-8111-111111111111";
const responsePayload = { reason: "nothing to wire" };

test("composes generic payload into request and normalizes gateway response", async () => {
  let captured;
  const adapter = createOpenAIAdapter({ requestFn: async (request) => {
    captured = request;
    return { status: "completed", payload: { tool_use: { name: "no_wiring_needed", input: responsePayload } } };
  } });
  const result = await adapter.call({ payload: { request_id: requestId, developer_blocks: [{ content: "rules" }], user_blocks: [{ content: "task" }], expected_output: { type: "no_wiring_needed" } }, url: "http://gateway", credential: "secret" });
  assert.equal(result.type, "no_wiring_needed");
  assert.equal(result.parent_id, requestId);
  assert.equal(captured.preparedRequest.instructions, "rules");
  assert.equal(captured.preparedRequest.input.at(-1).content[0].text, "task");
  assert.equal(captured.preparedRequest.tools[0].name, "no_wiring_needed");
});

test("resolves transcript before composing request", async () => {
  const calls = [];
  const adapter = createOpenAIAdapter({ storage: { get: async (ref) => { calls.push(ref); return { data: { ref } }; } }, requestFn: async () => ({ payload: { tool_use: { name: "no_wiring_needed", input: responsePayload } } }) });
  await adapter.call({ payload: { request_id: requestId, conversation_mode: "hybrid", hybrid_window: 1, transcript_blocks: [{ block_id: "r1", round: 1, in_window: true, cacheable: false, response_summary: "old", full_request_ref: "req", full_response_ref: "res" }], user_blocks: [], expected_output: { type: "no_wiring_needed" } } });
  assert.deepEqual(calls.sort(), ["req", "res"]);
});

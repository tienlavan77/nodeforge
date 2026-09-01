import assert from "node:assert/strict";
import test from "node:test";
import { normalizeResponse } from "../../src/modules/agent/provider-adapters/openai-response-normalizer.js";

const parent = "11111111-1111-4111-8111-111111111111";

test("normalizes Responses API code_needed function call", () => {
  const result = normalizeResponse({ output: [{ type: "function_call", name: "code_needed", arguments: JSON.stringify({ files_requested: ["src/a.js"], reason: "inspect" }) }] }, { request_id: parent });
  assert.equal(result.role, "agent");
  assert.equal(result.type, "code_needed");
  assert.equal(result.parent_id, parent);
  assert.deepEqual(result.payload.files_requested, ["src/a.js"]);
});

test("normalizes OpenAI json_schema output text", () => {
  const payload = { type: "no_wiring_needed", reason: "no import required" };
  const result = normalizeResponse({ output_text: JSON.stringify(payload) }, { request_id: parent });
  assert.equal(result.type, "no_wiring_needed");
  assert.equal(result.payload.reason, payload.reason);
});

test("unwraps the provider-neutral agent_tool wrapper by kind", () => {
  const result = normalizeResponse({ tool_use: { name: "agent_tool", input: { kind: "request_info", tool: "read_context", files_requested: ["src/a.js"], reason: "inspect" } } }, { request_id: parent });
  assert.equal(result.type, "code_needed");
  assert.deepEqual(result.payload.files_requested, ["src/a.js"]);
});

test("maps submit_code alias and preserves payload", () => {
  const payload = { explanation: "done", files: [{ path: "src/a.js", language: "js", format: "full_content", content: "export {};", exists: false, before_checksum: null }] };
  const result = normalizeResponse({ tool_use: { name: "submit_code", input: payload } }, { request_id: parent });
  assert.equal(result.type, "submit_code_response");
  assert.deepEqual(result.payload, payload);
});

test("supports Chat Completions tool calls and requestId alias", () => {
  const result = normalizeResponse({ choices: [{ message: { tool_calls: [{ function: { name: "no_wiring_needed", arguments: JSON.stringify({ reason: "no import required" }) } }] } }] }, { requestId: parent });
  assert.equal(result.type, "no_wiring_needed");
  assert.equal(result.parent_id, parent);
});

test("normalizes completed and continue tool calls", () => {
  const completed = { status: "completed", report: { summary: "ok", files_changed: [], criteria_check: [] } };
  assert.equal(normalizeResponse({ output: [{ type: "function_call", name: "completed", arguments: JSON.stringify(completed) }] }, { request_id: parent }).type, "completed");
  const continued = { status: "continue", next_task: { description: "wire it" } };
  assert.equal(normalizeResponse({ output: [{ type: "function_call", name: "continue", arguments: JSON.stringify(continued) }] }, { request_id: parent }).type, "continue");
});

test("rejects malformed, unsupported, and payload-invalid responses", () => {
  assert.throws(() => normalizeResponse({ output: [{ type: "function_call", name: "code_needed", arguments: "{" }] }, { request_id: parent }), /PROVIDER_TOOL_ARGUMENTS_INVALID/);
  assert.throws(() => normalizeResponse({ output: [{ type: "function_call", name: "unknown", arguments: "{}" }] }, { request_id: parent }), /PROVIDER_TOOL_UNSUPPORTED/);
  assert.throws(() => normalizeResponse({ output: [{ type: "function_call", name: "code_needed", arguments: "{}" }] }, { request_id: parent }), /PROVIDER_PAYLOAD_INVALID/);
  assert.throws(() => normalizeResponse({ output: [] }, { request_id: parent }), /PROVIDER_RESPONSE_INVALID/);
  assert.throws(() => normalizeResponse({}, {}), /PROVIDER_CONTEXT_INVALID/);
});

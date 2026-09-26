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

test("rejects the removed agent_tool wrapper", () => {
  assert.throws(() => normalizeResponse({ tool_use: { name: "agent_tool", input: { kind: "request_info", files_requested: ["src/a.js"], reason: "inspect" } } }, { request_id: parent }), /PROVIDER_TOOL_UNSUPPORTED/);
});

test("maps submit_code alias and preserves payload", () => {
  const payload = { explanation: "done", files: [{ path: "src/a.js", format: "full_content", content: "export {};", exists: false, before_checksum: null }] };
  const result = normalizeResponse({ tool_use: { name: "submit_code", input: payload } }, { request_id: parent });
  assert.equal(result.type, "submit_code_response");
  assert.deepEqual(result.payload, {
    explanation: "done",
    files: [{ path: "src/a.js", format: "full_content", content: "export {};", exists: false, before_checksum: null }]
  });
});

// Keeps the supplied checksum and existence state for an existing file patch.
test("preserves existing file state in submit_code_response", () => {
  const checksum = `sha256:${"a".repeat(64)}`;
  const file = { path: "src/a.js", format: "structured_patch", content: { operations: [{ op: "replace_range", expected_content: "old", new_content: "new" }] }, exists: true, before_checksum: checksum };
  const result = normalizeResponse({ tool_use: { name: "submit_code_response", input: { explanation: "updated", files: [file] } } }, { request_id: parent });
  assert.deepEqual(result.payload.files, [file]);
});

// Rejects incomplete file state instead of guessing whether a file already exists.
test("rejects submit_code_response without file existence or checksum", () => {
  const file = { path: "src/a.js", format: "full_content", content: "export {};" };
  assert.throws(() => normalizeResponse({ tool_use: { name: "submit_code_response", input: { explanation: "added", files: [file] } } }, { request_id: parent }), /PROVIDER_PAYLOAD_INVALID/);
  assert.throws(() => normalizeResponse({ tool_use: { name: "submit_code_response", input: { explanation: "added", files: [{ ...file, exists: true, before_checksum: null }] } } }, { request_id: parent }), /PROVIDER_PAYLOAD_INVALID/);
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

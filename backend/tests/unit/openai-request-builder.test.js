import assert from "node:assert/strict";
import test from "node:test";
import { buildInput, buildInstructions, buildResponseFormat, buildResponsesInput, buildToolConfig } from "../../src/modules/agent/provider-adapters/openai-request-builder.js";

test("places transcript blocks between cacheable developer and current user blocks", () => {
  const input = buildResponsesInput({ developer_blocks: [{ block_id: "rules", content: "rules", cacheable: true }], transcript_blocks: [{ block_id: "round_1", round: 1, instruction: "old", response_summary: "done", full_request_ref: "req", full_response_ref: "res", cacheable: false }], user_blocks: [{ block_id: "current", content: "now", cacheable: false }] });
  assert.equal(input[0].role, "developer");
  assert.equal(input[0].content[0].prompt_cache_breakpoint, true);
  assert.equal(input[1].role, "user");
  assert.equal(input[1].content[0].prompt_cache_breakpoint, undefined);
  assert.equal(input[2].role, "user");
});


test("builds ordered OpenAI instructions without Anthropic cache controls", () => {
  const instructions = buildInstructions({
    instruction_blocks: [{ content: "base rules", cacheable: true }],
    developer_blocks: [{ content: "project conventions", cacheable: true }, { content: "current constraints", cacheable: false }]
  });
  assert.equal(instructions, "base rules\n\nproject conventions\n\ncurrent constraints");
  assert.equal(instructions.includes("cache_control"), false);
});


test("builds ordered input from resolved transcript and appends current user blocks", () => {
  const input = buildInput({ user_blocks: [{ content: "current request", cacheable: false }] }, [
    { round: 2, in_window: true, instruction: "next", full_request: { id: "r2" }, full_response: { ok: true } },
    { round: 1, in_window: false, text: "old summary", cacheable: true }
  ]);
  assert.equal(input[0].content[0].text, "old summary");
  assert.match(input[1].content[0].text, /"id":"r2"/);
  assert.equal(input[2].content[0].text, "current request");
  assert.equal(input[2].content[0].prompt_cache_breakpoint, undefined);
});


test("builds OpenAI tool config from expected output", () => {
  const one = buildToolConfig({ expected_submission: { type: "submit_code" } });
  assert.equal(one.tools[0].name, "submit_code_response");
  assert.deepEqual(one.tool_choice, { type: "function", name: "submit_code_response" });
  const many = buildToolConfig({ expected_submission: { type: ["submit_code", "request_info"] } });
  assert.equal(many.tools.length, 2);
  assert.equal(many.tool_choice, "auto");
});

test("constrains Stage-1 submit tool to requested full format", () => {
  const config = buildToolConfig({ expected_output: { type: "submit_code_response", representation: "full_content" } });
  const format = config.tools[0].parameters.properties.files.items.properties.format;
  assert.deepEqual(format.enum, ["full_content"]);
});

test("projects a single response type to OpenAI json_schema transport", () => {
  const payload = { expected_output: { type: "submit_code_response", representation: "full_content", transport: "json_schema" } };
  const config = buildToolConfig(payload);
  const projected = buildResponseFormat(payload, config);
  assert.equal(projected.text.format.type, "json_schema");
  assert.equal(projected.text.format.name, "submit_code_response");
  assert.equal(projected.text.format.strict, true);
  assert.equal(projected.text.format.schema.properties.files.items.properties.format.enum[0], "full_content");
});

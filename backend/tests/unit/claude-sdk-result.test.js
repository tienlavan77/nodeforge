/** Verifies Claude terminal results cannot mix discovery narration, tool-call
 * markup or subagent output into the final structured agent exchange. Failures
 * retain their provider outcome rather than being accepted as success text. */
import assert from "node:assert/strict";
import test from "node:test";
import { claudeSdkResult } from "../../src/modules/agent/claude-sdk-result.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";

/** Constructs an isolated gateway with SDK messages supplied by the test, using
 * no external provider or credential store while preserving option forwarding. */
function fixture(messages) {
  let options, terminal = "", closed = false;
  const gateway = createClaudeSdkGateway({ configuration: { getById: () => ({ agent_id: "AM", agent_name: "Architecture", role: "architecture_manager",
    provider: "anthropic", credential_ref: "runtime:am", gateway_url: "https://gateway.example.test", enabled: true, status: "ready" }) },
    credentialResolver: () => "private-test-credential", terminalOutput: { write: (line) => { terminal += line; } },
    queryFn: (input) => { options = input.options; return { async *[Symbol.asyncIterator]() { yield* messages; }, close() { closed = true; } }; } });
  return { execute: (extra = {}) => gateway.execute({ agentId: "AM", correlationId: "STRUCTURED", prompt: "Answer the assigned question.", ...extra }),
    get options() { return options; }, get terminal() { return terminal; }, get closed() { return closed; } };
}

test("gateway forwards native JSON Schema and returns only terminal structured_output", async () => {
  const value = { kind: "consultation_response", subject: "Answered.", payload: { outcome: "answered" }, evidence: [] };
  const f = fixture([
    { type: "assistant", message: { content: [{ type: "text", text: "I’m retrieving more evidence." }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "<tool_call>read_file</tool_call>" }, { type: "tool_use", name: "read_file" }] } },
    { type: "result", subtype: "success", is_error: false, result: "Provider display text.", structured_output: value, session_id: "S" },
    { type: "assistant", parent_tool_use_id: "SUBAGENT", message: { content: [{ type: "text", text: "Unrelated child result." }] } }
  ]);
  const outputFormat = { type: "json_schema", schema: { type: "object", properties: { kind: { type: "string" } }, required: ["kind"], additionalProperties: false } };
  const result = await f.execute({ options: { outputFormat } });
  assert.deepEqual(f.options.outputFormat, outputFormat);
  assert.deepEqual(result.structured_output, value);
  assert.equal(result.text, JSON.stringify(value));
  assert.equal(result.messages.length, 4);
  assert.equal(result.session_id, "S");
  assert.equal(f.closed, true);
});

test("plain-text terminal result replaces all intermediate assistant commentary", async () => {
  const f = fixture([
    { type: "assistant", message: { content: [{ type: "text", text: "Looking at source." }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Final assistant message." }] } },
    { type: "result", subtype: "success", is_error: false, result: "Final result only." }
  ]);
  assert.equal((await f.execute()).text, "Final result only.");
  const legacy = claudeSdkResult([
    { type: "assistant", message: { content: [{ type: "text", text: "Old commentary." }] } },
    { type: "assistant", message: { content: [{ type: "text", text: "Last main answer." }] } },
    { type: "assistant", parent_tool_use_id: "CHILD", message: { content: [{ type: "text", text: "Child answer." }] } }
  ]);
  assert.equal(legacy.text, "Last main answer.");
});

test("known structured-output failure never falls back to prose or JSON-looking text", async () => {
  for (const result of [
    { type: "result", subtype: "error_max_structured_output_retries", is_error: true, errors: ["Schema generation failed."] },
    { type: "result", subtype: "success", is_error: true, result: "API Error: private-test-credential" },
    { type: "result", subtype: "success", is_error: false, result: '{"looks":"valid"}' }
  ]) {
    const f = fixture([{ type: "assistant", message: { content: [{ type: "text", text: "An unvalidated answer." }] } }, result]);
    await assert.rejects(f.execute({ options: { outputFormat: { type: "json_schema", schema: { type: "object" } } } }), (error) => {
      assert.equal(error.provider_outcome, "failed");
      assert.equal(error.retry_safe, false);
      assert.match(error.code, /^CLAUDE_SDK_(RESULT_ERROR|STRUCTURED_OUTPUT_MISSING)$/);
      assert.doesNotMatch(error.message, /private-test-credential/);
      return true;
    });
    assert.match(f.terminal, /FAIL Architecture/);
    assert.doesNotMatch(f.terminal, /DONE Architecture/);
    assert.equal(f.closed, true);
  }
});

test("missing terminal completion retains unknown provider ownership for structured turns", async () => {
  const f = fixture([{ type: "assistant", message: { content: [{ type: "text", text: '{"draft":true}' }] } }]);
  await assert.rejects(f.execute({ options: { outputFormat: { type: "json_schema", schema: { type: "object" } } } }),
    { code: "CLAUDE_SDK_RESULT_MISSING", provider_outcome: "unknown", retry_safe: false });
});

test("terminal provider error status remains available to existing transient retry classification", async () => {
  const f = fixture([{ type: "result", subtype: "success", is_error: true, api_error_status: 503, result: "Service temporarily unavailable." }]);
  await assert.rejects(f.execute(), { provider_outcome: "failed", retry_safe: true });
});

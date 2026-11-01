/** Verifies native output schemas reach Codex on both new and resumed turns,
 * while progress narration stays separate from the terminal exchange response.
 * The SDK stub avoids external requests and writes only to an isolated home. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";

test("new and resumed Codex turns retain native schema and only the last response", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-output-"));
  const schema = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } }).schema;
  const value = { kind: "consultation_response", subject: "One question answered.", payload: {}, evidence: [] };
  const calls = [];
  try {
    const gateway = createCodexSdkGateway({ codexHomeRoot: root, terminalOutput: { write() {} },
      configuration: { getById: () => ({ agent_id: "AM", role: "architecture_manager", gateway_url: "https://gateway.test",
        credential_ref: "fixture", enabled: true, status: "ready" }) }, credentialResolver: () => "fixture-key",
      CodexClass: class {
        // Records new-thread dispatch while preserving the same streaming SDK surface.
        startThread() { calls.push("start"); return this.resumeThread("T", true); }
        // Simulates a resumed SDK stream with intermediate narration and a final JSON response.
        resumeThread(id, initial = false) {
          if (initial !== true) calls.push("resume");
          return { id, runStreamed: async (_prompt, options) => {
            assert.deepEqual(options.outputSchema, schema);
            assert(options.signal instanceof AbortSignal);
            return { events: (async function* () {
              yield { type: "item.completed", item: { type: "agent_message", text: "I'm retrieving evidence." } };
              yield { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } };
              yield { type: "turn.completed", usage: { input_tokens: 12, output_tokens: 4 } };
            })() };
          } };
        }
      } });
    for (const resumeThreadId of [undefined, "T"]) {
      const result = await gateway.execute({ agentId: "AM", prompt: "Answer the retained question.", correlationId: "STRUCTURED",
        resumeThreadId, options: { outputSchema: schema } });
      assert.equal(result.text, JSON.stringify(value));
      assert.equal(result.thread_id, "T");
      assert.equal(result.items.length, 2);
      assert.equal(result.context_input_tokens, 12);
    }
    assert.deepEqual(calls, ["start", "resume"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex SDK forwards configured max_output_tokens and classifies truncated output as SDK_MAX_OUTPUT_TOKENS", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-max-tokens-"));
  let codexConfig;
  try {
    const gateway = createCodexSdkGateway({ codexHomeRoot: root, terminalOutput: { write() {} },
      configuration: { getById: () => ({ agent_id: "SL", role: "sprint_leader", gateway_url: "https://gateway.test",
        credential_ref: "fixture", enabled: true, status: "ready", max_output_tokens: 4096 }) }, credentialResolver: () => "fixture-key",
      CodexClass: class {
        constructor(options) { codexConfig = options.config; }
        startThread() {
          return { id: "T", runStreamed: async () => ({ events: (async function* () {
            yield { type: "item.completed", item: { type: "agent_message", text: "{\"kind\":\"consultation_response\"" } };
            yield { type: "turn.completed", incomplete_details: { reason: "max_output_tokens" }, usage: { input_tokens: 100, output_tokens: 4096 } };
          })() }) };
        }
      } });
    await assert.rejects(gateway.execute({ agentId: "SL", prompt: "Investigate", correlationId: "MAX-TOK" }), (error) => {
      assert.equal(error.code, "SDK_MAX_OUTPUT_TOKENS");
      assert.equal(error.incomplete_details?.reason, "max_output_tokens");
      return true;
    });
    assert.equal(codexConfig.model_max_output_tokens, 4096);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Codex SDK estimates context_input_tokens by model invocation rounds rather than dividing by parallel tool count", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-context-tokens-"));
  try {
    const gateway = createCodexSdkGateway({ codexHomeRoot: root, terminalOutput: { write() {} },
      configuration: { getById: () => ({ agent_id: "CODER", role: "coder", gateway_url: "https://gateway.test",
        credential_ref: "fixture", enabled: true, status: "ready" }) }, credentialResolver: () => "fixture-key",
      CodexClass: class {
        startThread() {
          return { id: "T-CTX", runStreamed: async () => ({ events: (async function* () {
            yield { type: "item.completed", item: { type: "reasoning", text: "Planning parallel reads" } };
            yield { type: "item.completed", item: { type: "mcp_tool_call", tool: "read_file" } };
            yield { type: "item.completed", item: { type: "mcp_tool_call", tool: "Read" } };
            yield { type: "item.completed", item: { type: "mcp_tool_call", tool: "search_text" } };
            yield { type: "item.completed", item: { type: "agent_message", text: "Done" } };
            yield { type: "turn.completed", usage: { input_tokens: 240000, cached_input_tokens: 180000, output_tokens: 500 } };
          })() }) };
        }
      } });
    const result = await gateway.execute({ agentId: "CODER", prompt: "Inspect files", correlationId: "CTX-TOK" });
    // 3 parallel tool calls in one batch + 1 final response = 2 model rounds -> 240000 / 2 = 120000 (not 240000 / 4 = 60000).
    assert.equal(result.context_input_tokens, 120000);
  } finally { await rm(root, { recursive: true, force: true }); }
});

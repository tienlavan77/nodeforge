// Verifies Claude SDK and Anthropic-compatible requests preserve prompt-cache policy and usage.
import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";
import { claudeCacheUsage } from "../../src/modules/agent/anthropic-prompt-cache.js";
import { buildAnthropicMessages, buildAnthropicSystem } from "../../src/modules/agent/provider-adapters/request-builder.js";
import * as anthropic from "../../src/modules/agent/provider-adapters/anthropic-adapter.js";
import * as claude from "../../src/modules/agent/provider-adapters/claude-adapter.js";

const payload = { instruction_blocks: [{ content: "Stable rules", cacheable: true }], user_blocks: [{ content: "Stable project", cacheable: true }, { content: "Current task", cacheable: false }] };
const usage = { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 300, cache_creation_input_tokens: 400 };

test("API cache policy marks only stable blocks with the selected TTL", () => {
  assert.equal(buildAnthropicSystem(payload)[0].cache_control.ttl, "1h");
  assert.equal(buildAnthropicMessages(payload)[0].content[0].cache_control.ttl, "1h");
  for (const ttl of ["5m", "1h"]) {
    const input = { ...payload, cache_config: { ttl } };
    assert.deepEqual(buildAnthropicSystem(input)[0].cache_control, { type: "ephemeral", ttl });
    const content = buildAnthropicMessages(input)[0].content;
    assert.deepEqual(content[0].cache_control, { type: "ephemeral", ttl });
    assert.equal(content[1].cache_control, undefined);
  }
  assert.equal(buildAnthropicSystem({ ...payload, cache_enabled: false })[0].cache_control, undefined);
  assert.equal(buildAnthropicMessages({ ...payload, cache_enabled: false })[0].content[0].cache_control, undefined);
  assert.throws(() => buildAnthropicSystem({ ...payload, cache_config: { ttl: "bad" } }), /TTL/);
});

test("Claude SDK enables cache and preserves usage without exposing credentials or summing cumulative results", async () => {
  for (const provider of ["anthropic", "claude"]) {
    let options;
    const terminal = [];
    const gateway = createClaudeSdkGateway({
      configuration: { getById: () => ({ agent_id: "agent", agent_name: "Claude", provider, enabled: true, status: "ready", gateway_url: "https://gateway.test", credential_ref: "credential" }) },
      credentialResolver: () => "secret-value", environment: { DISABLE_PROMPT_CACHING: "1", FORCE_PROMPT_CACHING_5M: "1" }, terminalOutput: { write: (line) => terminal.push(line) },
      // Emits repeated cumulative results to detect cache usage double counting.
      queryFn: (request) => {
        options = request.options;
        return { async *[Symbol.asyncIterator]() {
          yield { type: "result", modelUsage: { model: { inputTokens: 1, cacheReadInputTokens: 1 } } };
          yield { type: "result", modelUsage: { model: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 400 } }, api_key: "secret-value", authorization: "secret-value" };
        } };
      }
    });
    const result = await gateway.execute({ agentId: "agent", prompt: "Inspect", correlationId: "CACHE", options: { env: { DISABLE_PROMPT_CACHING_SONNET: "1" } } });
    assert.equal(options.env.DISABLE_PROMPT_CACHING, "0");
    assert.equal(options.env.DISABLE_PROMPT_CACHING_SONNET, "0");
    assert.equal(options.env.CLAUDE_CODE_PROMPT_CACHE_TTL, "1h");
    assert.equal(options.env.CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL, "1h");
    assert.equal(options.env.FORCE_PROMPT_CACHING_5M, "0");
    assert.deepEqual(result.usage, usage);
    assert.equal(result.messages[1].modelUsage.model.cacheReadInputTokens, 300);
    assert.equal(JSON.stringify(result).includes("secret-value"), false);
    assert.match(terminal.join(""), /cache_read=300 cache_write=400/);
  }
  assert.deepEqual(claudeCacheUsage([{ type: "result", usage }]), usage);
  assert.equal(claudeCacheUsage([]), undefined);
});

test("Anthropic and Claude API adapters preserve cache writes and reads in request and stream modes", async () => {
  const original = globalThis.fetch;
  try {
    for (const adapter of [anthropic, claude]) {
      const bodies = [];
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        bodies.push(body);
        if (!body.stream) return Response.json({ id: "response", content: [{ type: "text", text: "Done" }], usage });
        const events = [
          { type: "message_start", message: { usage: { ...usage, output_tokens: 0 } } },
          { type: "message_delta", usage: { output_tokens: 20 } },
          { type: "message_stop" }
        ];
        return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
      };
      const input = { url: "https://gateway.test/v1/messages", credential: "secret", payload, model: "claude-sonnet", correlationId: "CACHE" };
      assert.deepEqual((await adapter.request(input)).payload.usage, usage);
      const chunks = [];
      for await (const chunk of adapter.stream(input)) chunks.push(chunk);
      assert.deepEqual(chunks.filter((chunk) => chunk.usage).at(-1).usage, usage);
      assert.deepEqual(bodies[0].system, bodies[1].system);
      assert.equal(bodies[1].system[0].cache_control.type, "ephemeral");
      assert.deepEqual(bodies[0].messages, bodies[1].messages);
    }
  } finally { globalThis.fetch = original; }
});

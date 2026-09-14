import assert from "node:assert/strict";
import test from "node:test";
import { buildCacheOptions, buildResponsesInput } from "../../src/modules/agent/provider-adapters/openai-request-builder.js";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";

const baseConfig = { prompt_cache_key: "forge:P:s:T", mode: "explicit", ttl: "30m" };

test("buildCacheOptions adds store chaining only when previous_response_id is present", () => {
  const plain = buildCacheOptions({ cache_config: baseConfig });
  assert.deepEqual(plain, { prompt_cache_key: baseConfig.prompt_cache_key, prompt_cache_options: { mode: "explicit", ttl: "30m" } });
  assert.equal(plain.store, undefined);

  const primed = buildCacheOptions({ cache_config: baseConfig, previous_response_id: "store_only" });
  assert.equal(primed.store, true);
  assert.equal(primed.previous_response_id, undefined);

  const chained = buildCacheOptions({ cache_config: baseConfig, previous_response_id: "resp_123" });
  assert.equal(chained.store, true);
  assert.equal(chained.previous_response_id, "resp_123");
  assert.equal(chained.prompt_cache_key, baseConfig.prompt_cache_key);
});

test("sender worker attaches previous_response_id only for opted-in codex/openai profiles", async () => {
  const conversationState = { last_provider_response_id: null };
  const store = {
    get: async () => ({ ...conversationState }),
    update: async (id, changes) => { conversationState.last_provider_response_id = changes.last_provider_response_id ?? conversationState.last_provider_response_id; }
  };
  const captured = [];
  const makeWorker = (config) => createSenderWorker({
    queue: { claim: async () => job, ack: async () => {}, reject: async () => {} },
    agentRegistry: { resolve: () => ({ adapter: { send: async ({ payload }) => { captured.push(payload); return { type: "session.result", summary: "done", payload: { response_id: "resp_new_1" } }; } }, config }) },
    eventBus: { publish: async () => {} },
    toolRegistry: {},
    conversationStateStore: store,
    conversationIdResolver: () => "CONV-PROBE"
  });
  const job = {
    task_id: "TASK-PROBE", supervisor_id: "SUP-1", request_id: "REQ-P1", correlation_id: "CORR-P1", attempt: 1, agent_id: "builder",
    payload: { type: "task", task_id: "TASK-PROBE", step_id: 1, expected_output: { type: "code_needed", transport: "function_tool" }, execution_context: { capabilities: ["read_transcript_blocks"], task_id: "TASK-PROBE" }, transcript_blocks: [], cache_config: baseConfig }
  };

  // Opted-in codex profile: first turn has no stored id → store_only sentinel.
  await makeWorker({ provider: "codex", use_previous_response_id: true }).processOnce();
  assert.equal(captured[0].previous_response_id, "store_only");

  // Stored response id flows into the next request.
  conversationState.last_provider_response_id = "resp_prev_1";
  job.request_id = "REQ-P2";
  await makeWorker({ provider: "codex", use_previous_response_id: true }).processOnce();
  assert.equal(captured[1].previous_response_id, "resp_prev_1");

  // Opt-out profile: payload untouched.
  job.request_id = "REQ-P3";
  await makeWorker({ provider: "codex" }).processOnce();
  assert.equal(captured[2].previous_response_id, undefined);

  // Anthropic family ignores the flag.
  job.request_id = "REQ-P4";
  await makeWorker({ provider: "claude", use_previous_response_id: true }).processOnce();
  assert.equal(captured[3].previous_response_id, undefined);
});

test("buildResponsesInput ignores previous_response_id (request-body concern, not input)", () => {
  const input = buildResponsesInput({ previous_response_id: "resp_123", user_blocks: [{ block_id: "b", content: "x", cacheable: false }] });
  assert.equal(input.length, 1);
});

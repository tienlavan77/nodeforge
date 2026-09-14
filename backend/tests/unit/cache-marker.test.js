import assert from "node:assert/strict";
import test from "node:test";
import { buildAnthropicMessages, buildAnthropicSystem } from "../../src/modules/agent/provider-adapters/request-builder.js";
import { buildResponsesInput } from "../../src/modules/agent/provider-adapters/openai-request-builder.js";
import { createAttemptContextBuilder } from "../../src/modules/supervisor/attempt-context-builder.js";

const ticket = {
  id: "TICKET-CACHE",
  project_id: "PROJECT-NODEFORGE",
  title: "Cache tiers",
  objective: "Verify 3-tier payload markers",
  acceptance_criteria: ["Markers land at tier boundaries"]
};

function payload() {
  return {
    cache_config: { prompt_cache_key: `forge:${ticket.project_id}:default:${ticket.id}`, mode: "explicit", ttl: "30m" },
    instruction_blocks: [
      { block_id: "stage1-conventions", content: "conventions", cacheable: true },
      { block_id: "task-review", content: "review", cacheable: false }
    ],
    user_blocks: [
      { block_id: "project-memory", content: "memory facts", cacheable: true },
      { block_id: "task_context", content: "task text", cacheable: true },
      { block_id: "acceptance_criteria", content: "criteria", cacheable: true },
      { block_id: "context-pack", content: "tree", cacheable: true },
      { block_id: "repair-context-attempt-2", content: "failure", cacheable: false }
    ],
    transcript_blocks: []
  };
}

test("Anthropic markers land on tier boundaries only", () => {
  const system = buildAnthropicSystem(payload());
  assert.equal(system.filter((block) => block.cache_control).length, 1);
  assert.deepEqual(system[0].cache_control, { type: "ephemeral" });
  assert.equal(system[1].cache_control, undefined);

  const messages = buildAnthropicMessages(payload());
  const userMessage = messages.at(-1);
  assert.equal(userMessage.role, "user");
  const marked = userMessage.content.filter((block) => block.cache_control);
  assert.equal(marked.length, 4);
  assert.deepEqual(userMessage.content.at(-1).cache_control, undefined);
  assert.deepEqual(userMessage.content[0].cache_control, { type: "ephemeral" });
});

test("OpenAI breakpoints land on tier boundaries and prompt_cache_key is preserved", () => {
  const input = buildResponsesInput(payload());
  const marked = input.filter((entry) => entry.content[0].prompt_cache_breakpoint);
  assert.equal(marked.length, 4);
  assert.equal(input.at(-1).content[0].prompt_cache_breakpoint, undefined);
  assert.equal(input[1].content[0].prompt_cache_breakpoint, true);
});

test("repair request keeps tiers 1+2 byte-identical and appends failure last", async () => {
  const protocolStorage = { save: async () => {}, get: async () => ({ ref: "", data: null, metadata: {} }) };
  const builder = createAttemptContextBuilder({ protocolStorage });
  const attemptOne = await builder.buildAttemptRequest({
    task_id: "TASK-CACHE",
    correlation_id: "CORR-CACHE",
    ticket,
    agent_id: "builder",
    execution_context: null
  });
  const repair = await builder.buildRepairRequest({ task_id: "TASK-CACHE", attempt: 2, reason: "verification" }, { reason: "verification", failures: ["checksum mismatch"], gitDiff: "diff --git" });

  assert.equal(repair.payload.cache_config.prompt_cache_key, attemptOne.payload.cache_config.prompt_cache_key);
  const oneUser = attemptOne.payload.user_blocks;
  const repairUser = repair.payload.user_blocks;
  assert.equal(repairUser.length, oneUser.length + 1);
  assert.deepEqual(repairUser.slice(0, oneUser.length), oneUser);
  assert.equal(repairUser.at(-1).cacheable, false);
  assert.equal(repairUser.at(-1).block_id, "repair-context-attempt-2");

  const anthropicOne = buildAnthropicMessages(attemptOne.payload);
  const anthropicRepair = buildAnthropicMessages(repair.payload);
  assert.deepEqual(anthropicRepair.at(-1).content.slice(0, -1), anthropicOne.at(-1).content);
  assert.equal(anthropicRepair.at(-1).content.at(-1).cache_control, undefined);

  const openaiOne = buildResponsesInput(attemptOne.payload);
  const openaiRepair = buildResponsesInput(repair.payload);
  assert.deepEqual(openaiRepair.slice(0, openaiOne.length), openaiOne);
  assert.equal(openaiRepair.at(-1).content[0].prompt_cache_breakpoint, undefined);
});

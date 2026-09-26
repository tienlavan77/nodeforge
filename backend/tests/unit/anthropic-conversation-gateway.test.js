import assert from "node:assert/strict";
import test from "node:test";
import { createAnthropicConversationGateway } from "../../src/application/anthropic-conversation-gateway.js";

test("executes Forge tools and returns the final Anthropic conversation text", async () => {
  const calls = [];
  let round = 0;
  const gateway = createAnthropicConversationGateway({
    agentGateway: { request: async ({ payload }) => {
      round += 1;
      calls.push(payload);
      return round === 1
        ? { payload: { tool_use: { id: "call-1", name: "search_tree", input: { flags: [] } } } }
        : { payload: { text: "Claude found the files.", response_id: "resp-1" } };
    } },
    toolRegistry: { search_tree: { execute: async (input, context) => ({ tree: ".", input, task_id: context.task_id }) } },
    toolDefinitions: [{ name: "search_tree", description: "List the tree", input_schema: { type: "object" } }],
    toolContext: { task_id: "TASK-1" }
  });
  const result = await gateway.execute({ agentId: "architecture-manager", correlationId: "CORR-1", prompt: "Inspect files" });
  assert.equal(result.text, "Claude found the files.");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].messages.at(-1).content[0].type, "tool_result");
  assert.equal(calls[1].messages.at(-1).content[0].tool_use_id, "call-1");
});

import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

function harness(chunks) {
  const messages = [];
  const bus = { send(message) { messages.push(message); return message; }, sendFast(message) { messages.push(message); return message; }, flush: async () => {}, subscribe() {}, unsubscribe() {} };
  let calls = 0;
  let toolCalls = 0;
  const chat = createOwnerChatService({
    bus,
    streamBatchMs: 1,
    agentStream: async function* () { yield* chunks[calls++] ?? []; },
    executeAgentTool: async () => { toolCalls += 1; return { content: "should not run" }; }
  });
  return { chat, messages, calls: () => calls, toolCalls: () => toolCalls };
}

const input = { message_id: "MSG-STREAM-1", project_id: "PROJECT-114A", conversation_id: "CONV-OWNER-1", correlation_id: "CORR-STREAM-1", timestamp: new Date().toISOString(), agent_id: "architecture-manager", payload: { text: "Explain the design" } };

// Confirms normal owner chat completes through streamed text without invoking retired tools.
test("owner chat streams text and ignores legacy tool calls", async () => {
  const h = harness([[{ tool_use: { name: "agent_tool", input: { kind: "request_info", query: "ignored" } } }, { text: "A design answer." }, { completed: true }]]);
  h.chat.submit(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls(), 1);
  assert.equal(h.toolCalls(), 0);
  assert.equal(h.messages.at(-1).message_type, "architecture.message.received");
  assert.equal(h.messages.at(-1).payload.text, "A design answer.");
});

// Confirms tool-only responses cannot masquerade as completed owner-chat answers.
test("owner chat fails when the provider returns only a legacy tool call", async () => {
  const h = harness([[{ tool_use: { name: "agent_tool", input: { kind: "submit_code" } } }]]);
  h.chat.submit({ ...input, message_id: "MSG-STREAM-2", correlation_id: "CORR-STREAM-2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.toolCalls(), 0);
  assert.equal(h.messages.at(-1).message_type, "architecture.error");
});

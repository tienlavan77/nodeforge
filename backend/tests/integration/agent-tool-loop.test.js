import test from "node:test";
import assert from "node:assert/strict";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

function harness(chunks) {
  const messages = [];
  const bus = { send(message) { messages.push(message); return message; }, sendFast(message) { messages.push(message); return message; }, flush: async () => {}, subscribe() {}, unsubscribe() {} };
  let calls = 0;
  const chat = createOwnerChatService({
    bus,
    streamBatchMs: 1,
    agentStream: async function* () { yield* chunks[calls++] ?? []; },
    executeAgentTool: async (tool) => ({ content: tool.kind === "request_info" ? "context" : `wrote ${tool.target_path}` })
  });
  return { chat, messages, calls: () => calls };
}

const input = { message_id: "MSG-LOOP-1", project_id: "PROJECT-114A", conversation_id: "CONV-BUILDER-1", correlation_id: "CORR-LOOP-1", timestamp: new Date().toISOString(), agent_id: "builder", payload: { text: "implement NF-SVC-T01" } };

test("agent tool loop executes request_info then submit_code", async () => {
  const h = harness([
    [{ tool_use: { input: { kind: "request_info", tool: "read_context", query: "NF-SVC-T01", reason: "need context", round: 1, max_rounds: 5, next_action: "need_more_info" } } }],
    [{ tool_use: { input: { kind: "submit_code", target_path: "src/example.js", target_dir: "src", file_operation: "create", code_kind: "main", content: "export const x = 1;", files: [{ target_path: "tests/example.test.js", target_dir: "tests", file_operation: "create", code_kind: "test", content: "assert.equal(1, 1);" }], round: 2, max_rounds: 5, next_action: "done", is_final: true } } }]
  ]);
  h.chat.submit(input);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.calls(), 2);
  assert.equal(h.messages.filter((message) => message.message_type === "builder.tool.result").length, 2);
  assert.equal(h.messages.at(-1).message_type, "builder.message.received");
});

test("invalid tool request terminates with agent error", async () => {
  const h = harness([[{ tool_use: { input: { kind: "submit_code", target_path: "../outside", round: 9 } } }]]);
  h.chat.submit({ ...input, message_id: "MSG-LOOP-2", correlation_id: "CORR-LOOP-2" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.messages.at(-1).message_type, "builder.error");
});

test("duplicate context request reuses cached result and still reaches submit_code", async () => {
  const h = harness([
    [{ tool_use: { input: { kind: "request_info", tool: "read_context", query: "NF-SVC-T01", reason: "need context", next_action: "need_more_info" } } }],
    [{ tool_use: { input: { kind: "request_info", tool: "read_context", query: "NF-SVC-T01", reason: "still need context", next_action: "need_more_info" } } }],
    [{ tool_use: { input: { kind: "submit_code", target_path: "src/example.js", target_dir: "src", file_operation: "create", code_kind: "main", content: "export const x = 1;", files: [{ target_path: "tests/example.test.js", target_dir: "tests", file_operation: "create", code_kind: "test", content: "assert.equal(1, 1);" }], next_action: "done", is_final: true } } }]
  ]);
  h.chat.submit({ ...input, message_id: "MSG-LOOP-DUP", correlation_id: "CORR-LOOP-DUP" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(h.calls(), 3);
  assert.equal(h.messages.at(-1).message_type, "builder.message.received");
});

import assert from "node:assert/strict";
import test from "node:test";

import { createOwnerChatService } from "../../src/application/owner-chat-service.js";

// Exercises the ticket boundary so direct Builder chat cannot execute coding tools.
test("Builder chat requires Ticket Run and never invokes the direct tool loop", () => {
  const messages = [];
  let agentCalls = 0;
  let toolCalls = 0;
  const service = createOwnerChatService({
    bus: { send(message) { messages.push(message); return message; } },
    agentStream: async function* () { agentCalls += 1; yield { text: "unexpected" }; },
    executeAgentTool: async () => { toolCalls += 1; return { content: "unexpected" }; }
  });
  const input = {
    message_id: "MSG-LOOP-1", project_id: "PROJECT-114A", conversation_id: "CONV-BUILDER-1",
    correlation_id: "CORR-LOOP-1", timestamp: "2026-08-21T13:00:00Z", agent_id: "builder",
    payload: { text: "implement NF-SVC-T01", intent: "normal_chat" }
  };
  service.submit(input);
  assert.equal(agentCalls, 0);
  assert.equal(toolCalls, 0);
  assert.equal(messages.at(-1).message_type, "ticket.status");
  assert.equal(messages.at(-1).payload.error_code, "BUILDER_TICKET_REQUIRED");
  assert.equal(messages.at(-1).payload.status, "ticket_required");

  const duplicate = service.submit(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(messages.length, 2);
  assert.equal(toolCalls, 0);
});

// Verifies modal-created conversations remain selected when the owner sends the first message.
import assert from "node:assert/strict";
import test from "node:test";
import { createConversationRequest } from "../components/conversation-list-utils.js";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";

for (const executionRole of ["architecture-manager", "system-engineer"]) {
  // Keeps the API conversation in the sidebar and sends the first message without creating another chat.
  test(`${executionRole}: first message reuses the modal-created conversation`, async (context) => {
    const conversation = { id: "123e4567-e89b-42d3-a456-426614174000", title: "New plan" };
    const fetchRequest = context.mock.method(globalThis, "fetch", async () => ({
      ok: true, json: async () => ({ conversation })
    }));
    const onNewConversation = context.mock.fn();
    const created = await createConversationRequest(conversation.title, {
      projectId: "PROJECT-1", agentId: executionRole, onNewConversation
    });
    assert.deepEqual(created, conversation);
    assert.deepEqual(onNewConversation.mock.calls[0].arguments, [conversation.title, conversation]);
    assert.equal(fetchRequest.mock.calls.length, 1);
    assert.equal(fetchRequest.mock.calls[0].arguments[0], "/forge/v1/conversations");
    assert.deepEqual(JSON.parse(fetchRequest.mock.calls[0].arguments[1].body), {
      title: conversation.title, project_id: "PROJECT-1", agent_id: executionRole
    });

    const createConversation = context.mock.fn();
    const postOwnerMessage = context.mock.fn();
    const setActiveConversationId = context.mock.fn();
    const setChatState = context.mock.fn();
    const { sendMessage } = createHomeMessageHandlers({
      client: { createConversation, postOwnerMessage },
      projectId: "PROJECT-1", selectedArchitectureManager: { id: executionRole },
      activeConversationId: created.id, executionRole,
      setActiveConversationId, setChatState, setMessages: context.mock.fn(),
      setAgentTyping: context.mock.fn(), sendingRef: { current: false },
      lastSentRef: { current: null }, writeChatState: context.mock.fn()
    });
    await sendMessage("First message");
    assert.equal(createConversation.mock.calls.length, 0);
    assert.equal(setActiveConversationId.mock.calls.length, 0);
    assert.equal(postOwnerMessage.mock.calls.length, 1);
    assert.equal(postOwnerMessage.mock.calls[0].arguments[0].conversationId, conversation.id);
    assert.equal(postOwnerMessage.mock.calls[0].arguments[0].agentId, executionRole);
    assert.equal(postOwnerMessage.mock.calls[0].arguments[0].text, "First message");
    assert.deepEqual(setChatState.mock.calls.map((call) => call.arguments), [[""]]);
  });
}

// Prevents notification return values from replacing the authoritative API conversation.
test("create notification cannot replace the persisted conversation", async (context) => {
  const conversation = { id: "123e4567-e89b-42d3-a456-426614174000", title: "Plan" };
  context.mock.method(globalThis, "fetch", async () => ({ ok: true, json: async () => conversation }));
  const result = await createConversationRequest("Plan", {
    onNewConversation: async () => ({ id: "conv-local" })
  });
  assert.deepEqual(result, conversation);
});

// Keeps failed API requests from announcing or selecting a conversation that was not created.
test("failed creation rejects without notifying the page", async (context) => {
  context.mock.method(globalThis, "fetch", async () => ({
    ok: false, json: async () => ({ error: "Creation rejected" })
  }));
  const onNewConversation = context.mock.fn();
  await assert.rejects(createConversationRequest("Plan", { onNewConversation }), /Creation rejected/);
  assert.equal(onNewConversation.mock.calls.length, 0);
});

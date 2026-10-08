// Verifies inline owner corrections persist through the chat API and collapse into the reloaded conversation.
import assert from "node:assert/strict";
import test from "node:test";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";
import { mergeConversationRevisions } from "../lib/conversation-message-revisions.js";

// Preserve the original transcript position when a later edit arrives from another history page.
test("reloaded revisions replace owner text without hiding agent replies", () => {
  const original = { id: "MSG-1", stream_key: "owner:MSG-1", from: "owner", text: "Before", timestamp: "2026-01-01" };
  const response = { id: "MSG-2", stream_key: "agent:MSG-2", from: "agent", text: "Reply", timestamp: "2026-01-02" };
  const revision = { id: "MSG-1", source_message_id: "MSG-3", stream_key: "owner:MSG-1", from: "owner", text: "After", timestamp: "2026-01-03" };
  assert.deepEqual(mergeConversationRevisions([original, response, revision]).map(({ id, text }) => [id, text]), [["MSG-1", "After"], ["MSG-2", "Reply"]]);
  assert.equal(mergeConversationRevisions([original, ...mergeConversationRevisions([response, revision])])[0].text, "After");
});

// Post an owner correction with its original message id, updating the visible message only after the API accepts it.
test("inline edit saves a linked revision through the owner message endpoint", async () => {
  const owner = { id: "MSG-ORIGINAL", stream_key: "owner:MSG-ORIGINAL", from: "owner", text: "Old" };
  const posts = [];
  let messages = [owner];
  const handlers = createHomeMessageHandlers({
    client: { postOwnerMessage: async (input) => { posts.push(input); } }, projectId: "PROJECT-1", activeConversationId: "CONV-1",
    selectedArchitectureManager: { id: "architecture-manager" }, sendingRef: { current: false }, lastSentRef: { current: null },
    setMessages: (update) => { messages = update(messages); }, setAgentTyping: () => {}, setChatState: () => {}, messageIntent: "normal_chat"
  });
  await handlers.editMessage(owner, "  Corrected  ");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].supersedesMessageId, "MSG-ORIGINAL");
  assert.equal(posts[0].text, "Corrected");
  assert.equal(messages[0].id, "MSG-ORIGINAL");
  assert.equal(messages[0].text, "Corrected");
  assert.equal(messages[0].source_message_id, posts[0].messageId);
  assert.equal(messages[0].pending, false);
});

test("System Engineer retries use a System Engineer execution identity", async () => {
  const posts = [];
  const handlers = createHomeMessageHandlers({
    client: { postOwnerMessage: async (input) => posts.push(input) }, projectId: "PROJECT-1", activeConversationId: "123e4567-e89b-42d3-a456-426614174000",
    selectedArchitectureManager: { id: "engineer", role: "system_engineer" }, executionRole: "system-engineer", sendingRef: { current: false }, lastSentRef: { current: null },
    setMessages: () => {}, setAgentTyping: () => {}, setChatState: () => {}, messageIntent: "normal_chat"
  });
  await handlers.retryMessage({ id: "MSG-1", text: "Continue" });
  assert.match(posts[0].correlationId, /^CORR-system-engineer-RETRY-/);
});

// Builds the home workspace's owner-message send/retry handlers: conversation creation, optimistic UI, and failure recovery.

import { isPersistedConversationId, createChatId } from "./home-page-conversation-state.js";

// Creates the send and retry handlers for the home chat composer.
export function createHomeMessageHandlers({
  client,
  projectId,
  architectureConversationId,
  chatStateKey,
  selectedArchitectureManager,
  activeConversationId,
  setActiveConversationId,
  setChatState,
  setMessages,
  setAgentTyping,
  sendingRef,
  lastSentRef,
  writeChatState,
  messageIntent
}) {
  async function sendMessage(draft) {
    const text = draft.trim();
    if (!text) return;
    if (sendingRef.current) return;
    if (!selectedArchitectureManager) {
      setChatState("Select an Architecture Manager before sending a message.");
      return;
    }
    sendingRef.current = true;
    let conversationId = activeConversationId ?? selectedArchitectureManager.conversation_id ?? selectedArchitectureManager.conversationId ?? architectureConversationId;
    if (!isPersistedConversationId(conversationId)) {
      try {
        const conversation = await client.createConversation({ projectId, agentId: selectedArchitectureManager.id, title: text.slice(0, 120) });
        conversationId = conversation.id ?? conversation.conversation_id;
        if (!isPersistedConversationId(conversationId)) throw new Error("Node returned an invalid conversation id.");
        setActiveConversationId(conversationId);
        writeChatState(chatStateKey, selectedArchitectureManager.id, conversationId);
      } catch (error) {
        sendingRef.current = false;
        setChatState(error?.message ?? "Node could not create the conversation.");
        return;
      }
    }
    const messageId = createChatId("MSG-OWNER");
    const correlationId = createChatId("CORR-architecture-manager");
    const timestamp = new Date().toISOString();
    setChatState("");
    lastSentRef.current = { text, conversationId, messageId, correlationId };
    setMessages((current) => [...current, { id: messageId, stream_key: `owner:${messageId}`, text, from: "owner", nickname: "You", timestamp, correlation_id: correlationId, pending: true }]);
    setAgentTyping(true);
    try {
      await client.postOwnerMessage({
        projectId,
        conversationId,
        agentId: selectedArchitectureManager.id,
        messageId,
        correlationId,
        text,
        intent: messageIntent
      });
    } catch (error) {
      setAgentTyping(false);
      setMessages((current) => current.map((message) => message.id === messageId ? { ...message, pending: false, failed: true } : message));
      setChatState(error?.message ?? "Node rejected the owner message.");
    }
    sendingRef.current = false;
  }

  async function retryLastMessage() {
    const last = lastSentRef.current;
    if (!last || !selectedArchitectureManager) return;
    try {
      await client.postOwnerMessage({
        projectId,
        conversationId: last.conversationId,
        agentId: selectedArchitectureManager.id,
        messageId: createChatId("MSG-OWNER-RETRY"),
        correlationId: createChatId("CORR-architecture-manager-RETRY"),
        text: last.text,
        intent: messageIntent
      });
    } catch (error) {
      setChatState(error?.message ?? "Node rejected the owner message.");
    }
  }

  return { sendMessage, retryLastMessage };
}

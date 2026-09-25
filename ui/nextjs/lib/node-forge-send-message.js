// Composes and dispatches an owner chat/ticket message, with optimistic UI state and dispatch-timeout fallback.

import { PROJECT_ID, ARCHITECTURE_CONVERSATION_ID, CONVERSATIONS } from "./node-forge-app-constants.js";
import { formatDateLabel } from "./node-forge-history-format.js";

// Builds the `send(agentId)` handler used by the NodeForge app composer.
export function createSendMessageHandler({
  client,
  drafts,
  setDrafts,
  selectedArchitectureManager,
  setHistoryChat,
  pendingLive,
  pendingDispatchRef,
  dispatchTimersRef,
  setWorkingByAgent,
  loadDashboard,
  pushLiveHistory,
  scrollToBottom,
  detectMessageIntent,
  normalizeTicketInput,
  MESSAGE_INTENTS
}) {
  return async function send(agentId) {
    const text = drafts[agentId]?.trim();
    if (!text) return;
    // Chat composer always targets the selected conversation. Ticket creation
    // is handled by the sprint form; only an explicit /ticket command dispatches.
    const intent = /^\/ticket(?:\s|$)/i.test(text) ? detectMessageIntent(text) : MESSAGE_INTENTS.normalChat;
    const extractedTicket = intent === MESSAGE_INTENTS.ticketCreate ? normalizeTicketInput(text).ticket : undefined;
    const isDispatch = intent === MESSAGE_INTENTS.ticketDispatch;
    const targetAgentId = intent === MESSAGE_INTENTS.normalChat
      ? (agentId === "architecture-manager" ? selectedArchitectureManager?.id : agentId)
      : "builder";
    if (intent === MESSAGE_INTENTS.normalChat && agentId === "architecture-manager" && !selectedArchitectureManager) {
      setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: "No enabled Architecture Manager is available. Select an enabled agent before sending a message.", time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), message_type: "system.invalid_target" }] }));
      return;
    }
    const selectedConversationId = selectedArchitectureManager?.conversation_id ?? selectedArchitectureManager?.conversationId;
    const conversationId = intent === MESSAGE_INTENTS.normalChat && agentId === "architecture-manager"
      ? (selectedConversationId ?? CONVERSATIONS[targetAgentId] ?? ARCHITECTURE_CONVERSATION_ID)
      : (CONVERSATIONS[targetAgentId] ?? ARCHITECTURE_CONVERSATION_ID);
    const messageId = `MSG-OWNER-${Date.now()}-${targetAgentId}`;
    const nowIso = new Date().toISOString();
    const nowDate = new Date(nowIso);
    const optimistic = { id: messageId, correlation_id: `CORR-${agentId}-${Date.now()}`, message_type: "owner.message", from: "owner", text, time: nowDate.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: nowIso, dateKey: nowIso.slice(0, 10), dateLabel: formatDateLabel(nowIso) };
    setDrafts((current) => ({ ...current, [agentId]: "" }));
    if (isDispatch) pendingDispatchRef.current[agentId] = optimistic.correlation_id;
    setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), optimistic] }));
    pendingLive.current[agentId] = [...(pendingLive.current[agentId] ?? []), optimistic];
    requestAnimationFrame(() => scrollToBottom(agentId));
    try {
      const response = await client.postOwnerMessage({
        projectId: PROJECT_ID,
        conversationId,
        agentId: targetAgentId,
        messageId,
        correlationId: optimistic.correlation_id,
        text,
        intent,
        ticket: extractedTicket
      });
      // Some immediate Node responses (ticket.creation/status) can arrive
      // before the SSE subscription observes the persisted message. Render
      // the POST response as a fallback; SSE deduplication prevents doubles.
      if (response?.message_type && (response.message_id || response.id)) {
        pushLiveHistory(targetAgentId, { ...response, message_id: response.message_id ?? response.id });
      }
      if (response?.message_type === "ticket.creation") {
        const status = response.payload?.status;
        if (status === "created") {
          clearTimeout(dispatchTimersRef.current[agentId]);
          delete dispatchTimersRef.current[agentId];
          delete pendingDispatchRef.current[agentId];
          setWorkingByAgent((current) => ({ ...current, [agentId]: "READY" }));
          await loadDashboard();
        } else if (status) {
          setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
        }
      }
      if (!isDispatch) return;
      dispatchTimersRef.current[agentId] = setTimeout(() => {
        if (pendingDispatchRef.current[agentId] !== optimistic.correlation_id) return;
        delete pendingDispatchRef.current[agentId];
        setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
        const errTs = new Date().toISOString();
        setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: "Builder did not start the ticket within the expected time.", time: new Date(errTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: errTs, dateKey: errTs.slice(0, 10), dateLabel: formatDateLabel(errTs), message_type: "system.timeout" }] }));
      }, 15000);
    } catch (error) {
      delete pendingDispatchRef.current[agentId];
      setWorkingByAgent((current) => ({ ...current, [agentId]: "FAILED" }));
      const errTs = new Date().toISOString();
      setHistoryChat((m) => ({ ...m, [agentId]: [...(m[agentId] ?? []), { id: `ERR-${Date.now()}`, from: "system", text: error?.message ?? "Node request failed. Your message was not sent.", time: new Date(errTs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }), timestamp: errTs, dateKey: errTs.slice(0, 10), dateLabel: formatDateLabel(errTs), message_type: "system.error" }] }));
    }
  };
}

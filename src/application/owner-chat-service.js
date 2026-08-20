import { ConfigurationError } from "../shared/errors.js";

export function createOwnerChatService({ bus, architectureManagerId = "architecture-manager", agentRequest, agentStream, streamBatchMs = 3000 } = {}) {
  if (typeof bus?.send !== "function") throw new ConfigurationError("Owner Chat Service requires the shared Communication Bus.");
  if (!Number.isInteger(streamBatchMs) || streamBatchMs < 1) throw new ConfigurationError("Owner Chat stream batch interval must be positive.");
  const messages = new Map();

  return Object.freeze({ submit });

  function submit(input) {
    assertMessage(input);
    const existing = messages.get(input.message_id);
    if (existing) return { ...structuredClone(existing), duplicate: true };
    const message = {
      id: input.message_id,
      project_id: input.project_id,
      sender: { id: input.sender_id ?? "project-owner", role: "project_owner" },
      recipient: { id: architectureManagerId, role: "architecture_manager" },
      message_type: "owner.message",
      conversation_id: input.conversation_id,
      correlation_id: input.correlation_id,
      payload: { text: input.payload.text },
      timestamp: input.timestamp
    };
    // Bus persists via the canonical Communication Store before dispatching.
    const persisted = bus.send(message);
    messages.set(persisted.id, Object.freeze(structuredClone(persisted)));
    if (typeof agentStream === "function") void streamRealAgent(persisted);
    else if (typeof agentRequest === "function") void requestRealAgent(persisted);
    return structuredClone(persisted);
  }

  async function streamRealAgent(message) {
    let index = 0;
    let text = "";
    let batchText = "";
    let batchStart = 0;
    let timer;
    const flush = () => {
      if (!batchText) return;
      const payload = { text: batchText, accumulated_text: text, chunk_index: index++, batch_start: batchStart, batch_end: index - 1 };
      batchText = "";
      batchStart = index;
      bus.sendFast(responseMessage(message, "architecture.message.delta", payload, `DELTA-${index}`));
    };
    try {
      bus.send(responseMessage(message, "architecture.working", { agent_status: "WORKING" }, "WORKING"));
      for await (const chunk of agentStream({ agentId: architectureManagerId, payload: { text: message.payload.text }, correlationId: message.correlation_id })) {
        if (chunk.completed) continue;
        text += chunk.text;
        batchText += chunk.text;
        if (!timer) timer = setTimeout(() => { timer = undefined; flush(); }, streamBatchMs);
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      flush();
      await bus.flush();
      bus.send(responseMessage(message, "architecture.message.received", { text, agent_status: "COMPLETED" }, "COMPLETED"));
    } catch (error) {
      bus.send(responseMessage(message, "architecture.error", { error: error.message, agent_status: "FAILED" }, "ERROR"));
    }
  }

  async function requestRealAgent(message) {
    try {
      const result = await agentRequest({ agentId: architectureManagerId, payload: { text: message.payload.text }, correlationId: message.correlation_id });
      bus.send(responseMessage(message, "architecture.message.received", { text: result.payload?.text, response_id: result.payload?.response_id, agent_status: "COMPLETED" }));
    } catch (error) {
      bus.send(responseMessage(message, "architecture.error", { error: error.message, agent_status: "FAILED" }));
    }
  }

  function responseMessage(message, type, payload, suffix = type === "architecture.error" ? "ERROR" : "REAL") {
    return { id: `MSG-ARCHITECTURE-${suffix}-${message.id}`, project_id: message.project_id,
      sender: { id: architectureManagerId, role: "architecture_manager" }, recipient: { id: "NODE", role: "node" }, message_type: type,
      conversation_id: message.conversation_id, correlation_id: message.correlation_id, payload, timestamp: new Date().toISOString() };
  }
}

function assertMessage(input) {
  if (!input || typeof input !== "object" || typeof input.message_id !== "string" || input.message_id.length === 0
    || typeof input.project_id !== "string" || input.project_id.length === 0 || typeof input.conversation_id !== "string" || input.conversation_id.length === 0
    || typeof input.correlation_id !== "string" || input.correlation_id.length === 0 || typeof input.timestamp !== "string"
    || typeof input.payload?.text !== "string" || input.payload.text.trim().length === 0) {
    throw new ConfigurationError("Owner message requires message_id, project_id, conversation_id, correlation_id, timestamp, and text.");
  }
}

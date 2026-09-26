// Streams agent responses while coordinating context requests, tools, and completion events.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Streams owner agent text and publishes lifecycle events without legacy tool execution.
export function createOwnerAgentStream({ bus, agentStream, onAgentCompleted, debug, streamBatchMs, protocolStorage, conversationRounds, enrichAgentText, responseMessage }) {
  return streamRealAgent;

  // Streams one agent response and persists its completion envelope.
  async function streamRealAgent(message, agentId) {
    let index = 0;
    let text = "";
    let batchText = "";
    let batchStart = 0;
    let timer;
    let emittedFirstDelta = false;
    const flush = () => {
      if (!batchText) return;
      const payload = { text: batchText, accumulated_text: text, chunk_index: index++, batch_start: batchStart, batch_end: index - 1 };
      batchText = "";
      batchStart = index;
      bus.sendFast(responseMessage(message, streamEventType(agentId, "message.delta"), payload, `DELTA-${index}`));
    };
    try {
      bus.sendFast(responseMessage(message, "architecture.working", { agent_status: "WORKING" }, "WORKING"));
      const taskId = message.payload.task?.id ?? message.id;
      const requestPayload = { text: await enrichAgentText(message, agentId), ...(message.payload.task ? { task: message.payload.task } : {}) };
      debug({ event: "agent.stream.request", agent_id: agentId, task_id: taskId, payload: summarizePayload(requestPayload) });
      emitProgress(message, agentId, "Đang xử lý yêu cầu…", "PROGRESS-START");
      for await (const chunk of agentStream({ agentId, payload: requestPayload, correlationId: message.correlation_id, conversationId: message.conversation_id })) {
        if (chunk.usage) debug({ event: "agent.stream.usage", agent_id: agentId, task_id: taskId, usage: chunk.usage, cache_read_input_tokens: chunk.usage.cache_read_input_tokens ?? 0 });
        if (chunk.completed) continue;
        if (chunk.tool_use) {
          debug({ event: "agent.stream.tool_ignored", agent_id: agentId, task_id: taskId });
          continue;
        }
        if (typeof chunk.text !== "string") continue;
        text += chunk.text;
        debug({ event: "agent.stream.delta", agent_id: agentId, task_id: taskId, text: redactPreview(chunk.text) });
        if (!chunk.text) continue;
        if (!emittedFirstDelta) {
          emittedFirstDelta = true;
          bus.sendFast(responseMessage(message, streamEventType(agentId, "message.delta"), { text: chunk.text, accumulated_text: text, chunk_index: index++, batch_start: 0, batch_end: 0 }, `DELTA-${index}`));
          continue;
        }
        batchText += chunk.text;
        if (!timer) timer = setTimeout(() => { timer = undefined; flush(); }, streamBatchMs);
      }
      if (timer) { clearTimeout(timer); timer = undefined; }
      flush();
      if (!text.trim()) throw new ConfigurationError("Agent ended without a non-empty response.");
      await bus.flush();
      bus.send(responseMessage(message, streamEventType(agentId, "message.received"), { text, agent_status: "COMPLETED" }, "COMPLETED"));
      persistProtocolMessage({ ...message, payload: { ...message.payload, text } }, conversationRounds.get(message.conversation_id) ?? 1, "response");
      await onAgentCompleted?.({ message, agentId, text });
    } catch (error) {
      if (timer) clearTimeout(timer);
      bus.send(responseMessage(message, streamEventType(agentId, "error"), { error: error.message, agent_status: "FAILED" }, "ERROR"));
    }
  }

  // Emits a non-persisted progress signal for the active agent turn.
  function emitProgress(message, agentId, text, suffix) {
    debug({ event: "agent.stream.progress", agent_id: agentId, conversation_id: message.conversation_id, text });
    bus.sendFast(responseMessage(message, streamEventType(agentId, "message.progress"), { text, progress: true }, suffix));
  }

  // Persists a protocol envelope when protocol storage is configured.
  function persistProtocolMessage(message, round, direction) {
    if (!protocolStorage?.save || !message?.conversation_id) return;
    const taskId = message.payload?.task?.id ?? message.payload?.ticket?.id ?? message.conversation_id.replace(/[^A-Za-z0-9._-]/g, "-");
    const ref = `task/${taskId}/round_${round}/${direction}`;
    Promise.resolve(protocolStorage.save(ref, message, { schemaId: direction === "request" ? "forge-envelope" : "forge-response" }))
      .catch((error) => debug({ event: "protocol-storage.persist.error", ref, error: error.message }));
  }

}


// Formats agent-specific event names for the conversation stream.
function streamEventType(agentId, suffix) { return agentId === "architecture-manager" ? `architecture.${suffix}` : `${agentId}.${suffix}`; }

// Summarizes an agent payload for debug logging.
function summarizePayload(payload) {
  const text = String(payload?.text ?? "");
  return { chars: text.length, sha256: createHash("sha256").update(text).digest("hex"), preview: redactPreview(text, 2000), has_tools: Array.isArray(payload?.tools) && payload.tools.length > 0 };
}

// Redacts sensitive values from a text preview.
function redactPreview(value, limit = 500) {
  return String(value ?? "").replace(/(?:api[_-]?key|credential|secret|password|token|authorization)\s*[:=]\s*[^\s,}]+/gi, "$1=[REDACTED]").slice(0, limit);
}

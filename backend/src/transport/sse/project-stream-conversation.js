// Summary: Projects conversation messages and agent lifecycle events onto the project SSE contract.
import { normalizeErrorContract } from "../../shared/error-contract.js";

// Projects a communication message to project stream events.
export function projectConversationMessages(message) {
  const events = [];
  const primary = projectConversationMessage(message);
  const activity = projectConversationActivity(message);
  const status = projectConversationStatus(message);
  if (primary) events.push(primary);
  if (activity) events.push(activity);
  if (status) events.push(status);
  return events;
}

// Projects agent progress and tool lifecycle messages into a safe monitor event.
function projectConversationActivity(message) {
  const type = String(message?.message_type ?? "");
  const senderRole = String(message?.sender?.role ?? "").toLowerCase();
  if (["owner", "user", "node"].includes(senderRole) || typeof message?.sender?.id !== "string") return null;
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  const activityType = type.endsWith(".working") ? "started"
    : type.endsWith(".message.progress") || type.endsWith(".progress") ? "progress"
      : type.endsWith(".tool.result") ? "tool_result"
        : type.endsWith(".message.received") ? "completed"
          : type.endsWith(".error") || type.endsWith(".failed") ? "failed" : null;
  if (!activityType) return null;
  const status = activityType === "failed" ? "failed" : activityType === "completed" || activityType === "tool_result" ? "success" : "working";
  const summary = activityType === "progress" && typeof (payload.message ?? payload.text) === "string"
    ? (payload.message ?? payload.text).slice(0, 500)
    : activityType === "tool_result" ? `Finished tool: ${String(payload.tool_name ?? payload.tool ?? "tool").slice(0, 100)}`
      : activityType === "failed" ? "Agent task failed" : activityType === "completed" ? "Agent task completed" : "Agent started working";
  return {
    event_type: "agent.activity",
    payload: {
      agent_id: message.sender.id,
      ...(typeof message.conversation_id === "string" ? { conversation_id: message.conversation_id } : {}),
      ...(typeof message.correlation_id === "string" ? { correlation_id: message.correlation_id } : {}),
      activity_type: activityType,
      status,
      summary,
      ...(activityType === "tool_result" ? { tool_name: String(payload.tool_name ?? payload.tool ?? "tool").slice(0, 100) } : {})
    }
  };
}

// Projects a communication message to a project stream event.
function projectConversationMessage(message) {
  const type = String(message?.message_type ?? "");
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  const eventType = type === "owner.message" ? "conversation.message.owner"
    : type.endsWith(".message.delta") ? "conversation.message.delta"
      : type.endsWith(".message.received") || type === "owner.command.result" ? "conversation.message.received"
        : type.endsWith(".error") || type.endsWith(".failed") ? "conversation.message.failed" : null;
  if (!eventType || typeof message?.conversation_id !== "string") return null;
  if (eventType === "conversation.message.failed") {
    const sourceError = payload.error && typeof payload.error === "object" ? payload.error : { code: payload.code ?? "AGENT_ERROR", message: payload.error ?? payload.message ?? "Agent request failed.", retryable: payload.retryable };
    return {
      event_type: eventType,
      payload: {
        message_id: message.id,
        conversation_id: message.conversation_id,
        correlation_id: message.correlation_id ?? null,
        agent_id: message.sender?.id ?? null,
        sender_role: message.sender?.role ?? null,
        partial_text: typeof payload.accumulated_text === "string" ? payload.accumulated_text : typeof payload.text === "string" ? payload.text : null,
        error: normalizeErrorContract({ error: sourceError, requestId: message.correlation_id ?? null })
      }
    };
  }
  return {
    event_type: eventType,
    payload: {
      message_id: message.id,
      conversation_id: message.conversation_id,
      correlation_id: message.correlation_id ?? null,
      agent_id: message.sender?.id ?? null,
      sender_role: message.sender?.role ?? null,
      text: payload.text ?? null,
      chunk: payload.chunk ?? payload.text ?? null,
      done: eventType !== "conversation.message.delta"
    }
  };
}

// Derives an agent status event from a conversation message lifecycle signal.
function projectConversationStatus(message) {
  const type = String(message?.message_type ?? "");
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  const agentId = message?.sender?.id ?? payload.agent_id ?? null;
  if (typeof message?.conversation_id !== "string" || typeof agentId !== "string" || !agentId) return null;
  const explicit = typeof payload.agent_status === "string" ? payload.agent_status.toLowerCase() : null;
  let status = null;
  if (type.endsWith(".working") || explicit === "working") status = "working";
  else if (type.endsWith(".message.received") || explicit === "completed") status = "idle";
  else if (type.endsWith(".error") || type.endsWith(".failed") || explicit === "failed") status = "failed";
  if (!status) return null;
  return {
    event_type: "conversation.agent.status_changed",
    payload: {
      conversation_id: message.conversation_id,
      agent_id: agentId,
      previous_status: null,
      status,
      correlation_id: message.correlation_id ?? null
    }
  };
}

// Projects domain events to conversation stream events.
export function projectConversationEvents(event) {
  const primary = projectConversationEvent(event);
  if (!primary) return null;
  const events = [primary];
  const status = projectConversationEventStatus(event);
  if (status) events.push(status);
  return events;
}

// Projects a domain event to a conversation stream event.
function projectConversationEvent(event) {
  const type = String(event?.event_type ?? event?.type ?? "");
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const conversationId = payload.conversation_id ?? event?.metadata?.conversation_id;
  const eventType = type === "agent.message.received" ? "conversation.message.received"
    : type === "agent.text_stream" || type === "agent.message.delta" ? "conversation.message.delta" : null;
  if (!eventType || typeof event?.project_id !== "string" || typeof conversationId !== "string") return null;
  return {
    event_type: eventType,
    payload: {
      message_id: event.event_id ?? `EVENT-${event.task_id ?? "conversation"}-${event.timestamp}`,
      conversation_id: conversationId,
      correlation_id: payload.correlation_id ?? event.metadata?.correlation_id ?? event.task_id ?? null,
      agent_id: payload.agent_id ?? event.agent_id ?? event.metadata?.agent_id ?? null,
      sender_role: "agent",
      text: payload.text ?? null,
      chunk: payload.chunk ?? payload.text ?? null,
      done: eventType === "conversation.message.received" || payload.done === true
    }
  };
}

// Derives an agent status event from an agent lifecycle event.
function projectConversationEventStatus(event) {
  const type = String(event?.event_type ?? event?.type ?? "");
  const payload = event?.payload && typeof event.payload === "object" ? event.payload : {};
  const conversationId = payload.conversation_id ?? event?.metadata?.conversation_id;
  const agentId = payload.agent_id ?? event.agent_id ?? event.metadata?.agent_id ?? null;
  if (typeof event?.project_id !== "string" || typeof conversationId !== "string") return null;
  let status = null;
  if (type.endsWith(".working")) status = "working";
  else if (type === "agent.message.received") status = "idle";
  else if (type.endsWith(".error") || type.endsWith(".failed")) status = "failed";
  if (!status || typeof agentId !== "string" || !agentId) return null;
  return {
    event_type: "conversation.agent.status_changed",
    payload: {
      conversation_id: conversationId,
      agent_id: agentId,
      previous_status: null,
      status,
      correlation_id: payload.correlation_id ?? event.metadata?.correlation_id ?? event.task_id ?? null
    }
  };
}

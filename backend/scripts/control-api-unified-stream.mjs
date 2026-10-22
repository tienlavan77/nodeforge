// Bind SDK and supervisor activity to the owning project before live delivery or conversation persistence.
import { ConfigurationError } from "../src/shared/errors.js";

export function createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent, logger = console } = {}) {
  let sequence = 0;

  return function publishUnifiedStreamEvent(event) {
    if ([event.project_id, event.metadata?.project_id, event.payload?.project_id].some((identity) => identity !== undefined && identity !== projectId)) {
      throw Object.assign(new ConfigurationError("Unified stream event belongs to a different project."), { code: "PROJECT_CONTEXT_CONFLICT", statusCode: 409 });
    }
    let ordered = unifiedStreamOrder.assign({ ...event, project_id: projectId });
    const fullSeEvent = ordered.event_type === "agent.activity" && ordered.payload?.agent_role === "system_engineer" && ordered.payload?.sdk_event;
    if (!fullSeEvent) {
      internalBus.emit(ordered.event_type, ordered);
      internalBus.emit("event", ordered);
    }
    const conversationId = ordered.payload?.conversation_id;
    if (!conversationId) return ordered;
    try {
      const persisted = bus.send({
        id: `MSG-UNIFIED-${ordered.task_id ?? "EVENT"}-${Date.now()}-${++sequence}`,
        project_id: projectId,
        sender: { id: "NODE", role: "node" },
        recipient: { id: "project-owner", role: "project_owner" },
        message_type: ordered.event_type,
        conversation_id: conversationId,
        correlation_id: String(ordered.payload?.correlation_id ?? ordered.task_id ?? `UNIFIED-${sequence}`),
        payload: { ...ordered.payload, task_id: ordered.task_id, sequence: ordered.sequence },
        timestamp: ordered.timestamp
      });
      if (ordered.payload?.sdk_event?.type === "conversation_turn" && persisted?.payload) ordered = { ...ordered,
        payload: { ...ordered.payload, sdk_event: persisted.payload.sdk_event, sdk_sequence: persisted.payload.sdk_sequence } };
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 2000);
      try {
        logEvent({
          timestamp: new Date().toISOString(), event_name: "system.delivery_error", level: "error", status: "failed",
          message: `Unified stream delivery failed: ${detail}`, task_id: ordered.task_id ?? "UNIFIED-STREAM",
          ticket_id: ordered.payload?.ticket_id, conversation_id: conversationId, source: "control-api-unified-stream",
          error_code: "STREAM_DELIVERY_FAILED", payload: { event_type: ordered.event_type, message: detail, conversation_id: conversationId }
        });
      } catch (logError) {
        logger.error?.(`[unified-stream] delivery failed: ${detail}; log failed: ${logError.message}`);
      }
      if (fullSeEvent) throw error;
    }
    if (fullSeEvent) {
      internalBus.emit(ordered.event_type, ordered);
      internalBus.emit("event", ordered);
    }
    return ordered;
  };
}

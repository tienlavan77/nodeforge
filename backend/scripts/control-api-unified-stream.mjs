export function createUnifiedStreamPublisher({ unifiedStreamOrder, internalBus, bus, projectId, logEvent, logger = console } = {}) {
  let sequence = 0;

  return function publishUnifiedStreamEvent(event) {
    const ordered = unifiedStreamOrder.assign(event);
    internalBus.emit(ordered.event_type, ordered);
    internalBus.emit("event", ordered);
    const conversationId = ordered.payload?.conversation_id;
    if (!conversationId) return ordered;
    try {
      bus.send({
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
    }
    return ordered;
  };
}

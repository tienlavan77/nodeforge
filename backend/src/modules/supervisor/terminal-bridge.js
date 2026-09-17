// Summary: Bridges terminal task events to ticket/roadmap status updates and long-term memory capture.
import { ConfigurationError } from "../../shared/errors.js";

const TERMINAL_MAP = {
  "task.completed": "done",
  "task.failed": "failed",
  "task.needs_human_review": "needs_human_review"
};

const LONG_TERM_FACT = /\b(decision|architecture|migrat(?:e|ed|ion)?|standard|identity|rule engine|validator|always|must)\b/i;

/** Creates a bridge that maps terminal task events to ticket/roadmap and memory updates. */
export function createTerminalBridge({ eventBus, ticketStatusStore, roadmaps, projectId, taskSummaries, projectMemory, logger = () => {} } = {}) {
  if (typeof eventBus?.subscribe !== "function") throw new ConfigurationError("Terminal Bridge requires an execution event bus.");
  if (typeof ticketStatusStore?.updateStatus !== "function") throw new ConfigurationError("Terminal Bridge requires a Ticket Status Store.");
  if (typeof roadmaps?.updateTicketStatus !== "function") throw new ConfigurationError("Terminal Bridge requires a Roadmap Store.");
  if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Terminal Bridge requires a project_id.");
  const seen = new Set();
  const unsubscribe = eventBus.subscribe("*", (event) => handle(event).catch((error) => logger({ event_name: "terminal_bridge.failed", level: "error", status: "failed", message: "Terminal Bridge handling failed.", task_id: event?.task_id, source: "terminal-bridge", error_code: error.code ?? "TERMINAL_BRIDGE_FAILED", payload: { event_type: event?.type, request_id: event?.request_id, correlation_id: event?.correlation_id, error: error.message } })));
  return Object.freeze({ close: () => unsubscribe() });

  async function handle(event) {
    const ticketStatus = TERMINAL_MAP[event.type];
    if (!ticketStatus) return;
    const key = `${event.type}:${event.task_id}:${event.request_id ?? ""}:${event.correlation_id ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    const current = ticketStatusStore.get(event.task_id);
    if (!current) { logger({ event_name: "terminal_bridge.skipped", level: "warn", status: "skipped", message: "Terminal event for a ticket with no status row.", task_id: event.task_id, source: "terminal-bridge", payload: { event_type: event.type } }); return; }
    if (["done", "failed", "cancelled"].includes(current.status)) return;
    const errorText = typeof event.payload?.error === "string" ? event.payload.error : typeof event.payload?.error?.message === "string" ? event.payload.error.message : undefined;
    const details = { reason: `supervisor_${event.type}`, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt, ...(errorText ? { error: errorText } : {}) };
    if (!syncStatus(event.task_id, current.status, ticketStatus, details)) {
      logger({ event_name: "terminal_bridge.transition_skipped", level: "warn", status: "skipped", message: `Ticket status ${current.status} cannot transition to ${ticketStatus}; left for human review.`, task_id: event.task_id, source: "terminal-bridge", payload: { event_type: event.type, from: current.status, to: ticketStatus } });
      return;
    }
    roadmaps.updateTicketStatus({ projectId, ticketId: event.task_id, status: ticketStatus, ...(errorText ? { error: errorText } : {}) });
    logger({ event_name: "terminal_bridge.status_synced", level: "info", status: "success", message: `Terminal event synced to ticket status ${ticketStatus}.`, task_id: event.task_id, ticket_id: event.task_id, correlation_id: event.correlation_id, source: "terminal-bridge", payload: { event_type: event.type, from: current.status, to: ticketStatus, request_id: event.request_id } });
    if (event.type === "task.completed") recordMemory(event);
  }

  function syncStatus(taskId, from, to, details) {
    try {
      ticketStatusStore.updateStatus(taskId, to, details, { expectedCurrentStatus: from });
      return true;
    } catch (error) {
      if (error.code !== "STATUS_TRANSITION_INVALID" && error.code !== "STATUS_CONFLICT") throw error;
      // A CAS conflict means another writer moved the ticket first; re-read once
      // and apply the terminal status from the fresh state if it is now legal.
      if (error.code !== "STATUS_CONFLICT") return false;
      const fresh = ticketStatusStore.get(taskId);
      if (!fresh || ["done", "failed", "cancelled"].includes(fresh.status)) return false;
      try { ticketStatusStore.updateStatus(taskId, to, details, { expectedCurrentStatus: fresh.status }); return true; }
      catch (retryError) { if (retryError.code === "STATUS_TRANSITION_INVALID") return false; throw retryError; }
    }
  }

  function recordMemory(event) {
    try {
      const facts = longTermFacts(event.payload?.summary);
      if (taskSummaries?.record) taskSummaries.record(event.task_id, { project_id: projectId, facts });
      if (projectMemory?.build) projectMemory.build(projectId);
      logger({ event_name: "terminal_bridge.memory_recorded", level: "info", status: "success", message: "Terminal summary folded into project memory.", task_id: event.task_id, source: "terminal-bridge", payload: { fact_count: facts.length } });
    } catch (error) {
      logger({ event_name: "terminal_bridge.memory_failed", level: "error", status: "failed", message: "Memory recording failed.", task_id: event.task_id, source: "terminal-bridge", error_code: error.code ?? "MEMORY_RECORD_FAILED", payload: { error: error.message } });
    }
  }
}

function longTermFacts(summary) {
  if (typeof summary !== "string" || !summary.trim()) return [];
  return summary.split(/\n+/).map((line) => line.replace(/^[-*]\s*/, "").trim()).filter((line) => line && LONG_TERM_FACT.test(line));
}

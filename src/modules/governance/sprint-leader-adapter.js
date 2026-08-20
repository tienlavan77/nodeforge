import { ConfigurationError } from "../../shared/errors.js";

export function createSprintLeaderAdapter({ planner, bus, agentId = "sprint-leader", nodeId = "NODE" } = {}) {
  if (typeof planner?.selectCurrentSprint !== "function" || typeof planner?.generateTickets !== "function" || typeof planner?.prioritizeBacklog !== "function") {
    throw new ConfigurationError("Sprint Leader Adapter requires a Sprint Leader Planner.");
  }
  if (typeof bus?.subscribe !== "function" || typeof bus?.send !== "function") throw new ConfigurationError("Sprint Leader Adapter requires a Communication Bus.");
  const handled = new Set();
  const results = new Map();
  bus.subscribe(agentId, handle);

  return Object.freeze({ handle, getResult });

  function handle(message) {
    assertMessage(message);
    const requestId = message.payload?.request_id ?? message.id;
    const key = `${requestId}:${message.correlation_id ?? ""}`;
    if (handled.has(key)) return results.get(key) ? structuredClone(results.get(key)) : undefined;
    handled.add(key);
    try {
      const sprint = planner.selectCurrentSprint();
      const tickets = planner.prioritizeBacklog(planner.generateTickets());
      const result = Object.freeze({ request_id: requestId, correlation_id: message.correlation_id, sprint, tickets });
      results.set(key, result);
      bus.send({
        id: `MSG-SPRINT-PLAN-COMPLETED-${requestId}`,
        project_id: message.project_id,
        sender: { id: agentId, role: "sprint_lead" },
        recipient: { id: nodeId, role: "node" },
        message_type: "sprint.plan.completed",
        correlation_id: message.correlation_id,
        payload: structuredClone(result),
        timestamp: message.timestamp
      });
      return structuredClone(result);
    } catch (error) {
      handled.delete(key);
      throw error;
    }
  }

  function getResult(requestId, correlationId = "") {
    return structuredClone(results.get(`${requestId}:${correlationId}`));
  }
}

function assertMessage(message) {
  if (!message || typeof message !== "object" || message.message_type !== "sprint.plan.request" || typeof message.id !== "string" || typeof message.project_id !== "string" || typeof message.timestamp !== "string" || !message.payload || typeof message.payload !== "object") {
    throw new ConfigurationError("Sprint plan request message is invalid.");
  }
}

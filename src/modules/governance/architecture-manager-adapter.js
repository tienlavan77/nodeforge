import { ConfigurationError } from "../../shared/errors.js";

export function createArchitectureManagerAdapter({ manager, bus, agentId = "architecture-manager", nodeId = "NODE" } = {}) {
  if (typeof manager?.createArchitecturePlan !== "function" || typeof manager?.createRoadmap !== "function") {
    throw new ConfigurationError("Architecture Manager Adapter requires an Architecture Manager.");
  }
  if (typeof bus?.subscribe !== "function" || typeof bus?.send !== "function") throw new ConfigurationError("Architecture Manager Adapter requires a Communication Bus.");
  const handled = new Set();
  const results = new Map();
  bus.subscribe(agentId, handle);

  return Object.freeze({ handle, getResult });

  async function handle(message) {
    assertMessage(message);
    const requestId = message.payload?.request_id ?? message.id;
    const key = `${requestId}:${message.correlation_id ?? ""}`;
    if (handled.has(key)) return results.get(key) ? structuredClone(results.get(key)) : undefined;
    handled.add(key);
    try {
      if (message.message_type === "owner.message") return handleOwnerMessage(message, requestId, key);
      const input = structuredClone(message.payload?.request ?? message.payload);
      const plan = manager.createArchitecturePlan(input);
      const roadmapInput = {
        ...input,
        ...(input.roadmap ?? {}),
        architecture_decision_ids: plan.decisions.map(({ id }) => id),
        sprints: input.sprints ?? input.roadmap?.sprints
      };
      const roadmap = manager.createRoadmap(roadmapInput);
      const result = Object.freeze({ request_id: requestId, correlation_id: message.correlation_id, architecture_plan: plan, roadmap });
      results.set(key, result);
      bus.send({
        id: `MSG-ARCHITECTURE-COMPLETED-${requestId}`,
        project_id: message.project_id,
        sender: { id: agentId, role: "architecture_manager" },
        recipient: { id: nodeId, role: "node" },
        message_type: "architecture.completed",
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

  function handleOwnerMessage(message, requestId, key) {
    const plan = manager.createArchitecturePlan({
      project_id: message.project_id,
      created_at: message.timestamp,
      timestamp: message.timestamp,
      decisions: [{
        id: `DECISION-${requestId}`,
        type: "architecture",
        title: `Owner message ${requestId}`,
        decision: message.payload.text,
        status: "proposed"
      }]
    });
    const result = Object.freeze({ request_id: requestId, conversation_id: message.conversation_id, correlation_id: message.correlation_id, architecture_plan: plan });
    results.set(key, result);
    bus.send({
      id: `MSG-ARCHITECTURE-MESSAGE-${requestId}`,
      project_id: message.project_id,
      sender: { id: agentId, role: "architecture_manager" },
      recipient: { id: nodeId, role: "node" },
      message_type: "architecture.message.received",
      conversation_id: message.conversation_id,
      correlation_id: message.correlation_id,
      payload: structuredClone(result),
      timestamp: message.timestamp
    });
    return structuredClone(result);
  }
}

function assertMessage(message) {
  if (!message || typeof message !== "object" || !["architecture.request", "owner.message"].includes(message.message_type) || typeof message.id !== "string" || typeof message.project_id !== "string" || typeof message.timestamp !== "string" || !message.payload || typeof message.payload !== "object") {
    throw new ConfigurationError("Architecture request message is invalid.");
  }
}

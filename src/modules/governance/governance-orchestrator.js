import { ConfigurationError } from "../../shared/errors.js";

export function createGovernanceOrchestrator({ registry, bus, nodeId = "NODE" } = {}) {
  if (typeof registry?.get !== "function" || typeof bus?.send !== "function" || typeof bus?.subscribe !== "function") {
    throw new ConfigurationError("Governance Orchestrator requires an Agent Registry and Communication Bus.");
  }
  const architecture = requireAgent("architecture-manager");
  const sprintLeader = requireAgent("sprint-leader");
  const completed = new Map();
  const active = new Map();
  const audit = [];

  bus.subscribe("architecture-manager", onArchitectureRequest);
  bus.subscribe("sprint-leader", onSprintRequest);
  bus.subscribe(nodeId, onNodeMessage);

  return Object.freeze({ orchestrate, getAudit });

  function orchestrate(ownerRequest) {
    assertRequest(ownerRequest);
    const existing = completed.get(ownerRequest.correlation_id);
    if (existing) return Promise.resolve(structuredClone(existing));
    if (active.has(ownerRequest.correlation_id)) return active.get(ownerRequest.correlation_id).promise;
    let resolveResult;
    let rejectResult;
    const promise = new Promise((resolve, reject) => { resolveResult = resolve; rejectResult = reject; });
    active.set(ownerRequest.correlation_id, { promise, resolve: resolveResult, reject: rejectResult });
    bus.send({
      id: ownerRequest.id,
      project_id: ownerRequest.project_id,
      sender: { id: nodeId, role: "node" },
      recipient: { id: architecture.id, role: "architecture_manager" },
      message_type: "governance.architecture.request",
      correlation_id: ownerRequest.correlation_id,
      payload: structuredClone(ownerRequest.payload ?? ownerRequest),
      timestamp: ownerRequest.timestamp
    });
    return promise;
  }

  function onArchitectureRequest(message) {
    return dispatchAgent(architecture, message, "createArchitecturePlan", "governance.architecture.result");
  }

  function onSprintRequest(message) {
    return dispatchAgent(sprintLeader, message, "generateTickets", "governance.sprint.result");
  }

  function onNodeMessage(message) {
    if (message.message_type === "governance.architecture.result") {
      const request = active.get(message.correlation_id);
      if (!request) return;
      bus.send({
        id: `MSG-${message.correlation_id}-SPRINT-REQUEST`,
        project_id: message.project_id,
        sender: { id: nodeId, role: "node" },
        recipient: { id: sprintLeader.id, role: "sprint_lead" },
        message_type: "governance.sprint.request",
        correlation_id: message.correlation_id,
        payload: { architecture_result: structuredClone(message.payload.result), request: structuredClone(message.payload.request) },
        timestamp: message.timestamp
      });
      return;
    }
    if (message.message_type !== "governance.sprint.result") return;
    const request = active.get(message.correlation_id);
    if (!request) return;
      const result = { correlation_id: message.correlation_id, architecture: unwrap(message.payload.architecture_result), sprint: unwrap(message.payload.result) };
    completed.set(message.correlation_id, result);
    active.delete(message.correlation_id);
    request.resolve(structuredClone(result));
  }

  async function dispatchAgent(agent, message, operation, resultType) {
    try {
      const result = await agent.execute({ operation, ...(message.payload.request ?? message.payload) });
      bus.send({
        id: `MSG-${message.correlation_id}-${resultType}`,
        project_id: message.project_id,
        sender: { id: agent.id, role: messageRole(agent.role) },
        recipient: { id: nodeId, role: "node" },
        message_type: resultType,
        correlation_id: message.correlation_id,
        payload: { result, ...(message.payload.architecture_result ? { architecture_result: message.payload.architecture_result } : {}), request: message.payload.request },
        timestamp: message.timestamp
      });
      audit.push({ request: message.message_type, result: resultType, correlation_id: message.correlation_id });
    } catch (error) {
      const request = active.get(message.correlation_id);
      active.delete(message.correlation_id);
      request?.reject(error);
    }
  }

  function requireAgent(id) {
    const agent = registry.get(id);
    if (!agent || typeof agent.execute !== "function") throw new ConfigurationError(`Governance Agent is not registered: ${id}.`);
    return agent;
  }

  function getAudit() {
    return audit.map((entry) => ({ ...entry }));
  }
}

function assertRequest(request) {
  if (!request || typeof request !== "object" || typeof request.id !== "string" || typeof request.project_id !== "string" || typeof request.correlation_id !== "string" || typeof request.timestamp !== "string") {
    throw new ConfigurationError("Owner Request requires id, project_id, correlation_id, and timestamp.");
  }
}

function unwrap(result) {
  return result && typeof result === "object" && Object.hasOwn(result, "result") ? result.result : result;
}

function messageRole(role) {
  return role === "architecture-manager" ? "architecture_manager" : role === "sprint-leader" ? "sprint_lead" : role;
}

import { ConfigurationError } from "../shared/errors.js";

export function createOwnerRequestService({ governanceOrchestrator } = {}) {
  if (typeof governanceOrchestrator?.orchestrate !== "function") throw new ConfigurationError("Owner Request Service requires the Governance Orchestrator.");
  const requests = [];
  const byId = new Map();
  const byCorrelation = new Map();

  return Object.freeze({ submit, getById, getByCorrelationId });

  function submit(request) {
    validateRequest(request);
    if (byId.has(request.request_id)) throw new ConfigurationError(`Owner Request already exists: ${request.request_id}.`);
    const projectId = request.project_id ?? request.payload.project_id;
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("Owner Request payload requires project_id.");
    const stored = Object.freeze({ ...structuredClone(request), status: request.status ?? "accepted" });
    requests.push(stored);
    byId.set(stored.request_id, stored);
    byCorrelation.set(stored.correlation_id, stored);
    const dispatchRequest = {
      id: stored.request_id,
      project_id: projectId,
      correlation_id: stored.correlation_id,
      timestamp: stored.timestamp,
      payload: structuredClone(stored.payload)
    };
    Promise.resolve(governanceOrchestrator.orchestrate(dispatchRequest)).then(
      () => updateStatus(stored.request_id, "completed"),
      () => updateStatus(stored.request_id, "failed")
    );
    return clone(stored);
  }

  function getById(requestId) {
    assertId(requestId, "request");
    return clone(byId.get(requestId));
  }

  function getByCorrelationId(correlationId) {
    assertId(correlationId, "correlation");
    return clone(byCorrelation.get(correlationId));
  }

  function updateStatus(requestId, status) {
    const current = byId.get(requestId);
    if (!current) return;
    const updated = Object.freeze({ ...current, status });
    byId.set(requestId, updated);
    byCorrelation.set(updated.correlation_id, updated);
    const index = requests.findIndex(({ request_id: id }) => id === requestId);
    if (index >= 0) requests[index] = updated;
  }
}

function validateRequest(request) {
  if (!request || typeof request !== "object" || typeof request.request_id !== "string" || request.request_id.length === 0
    || typeof request.correlation_id !== "string" || request.correlation_id.length === 0 || typeof request.timestamp !== "string"
    || !request.payload || typeof request.payload !== "object" || Array.isArray(request.payload)) {
    throw new ConfigurationError("Owner Request requires request_id, correlation_id, timestamp, and object payload.");
  }
  if (request.status !== undefined && (typeof request.status !== "string" || request.status.length === 0)) {
    throw new ConfigurationError("Owner Request status must be a non-empty string.");
  }
}

function assertId(id, kind) {
  if (typeof id !== "string" || id.length === 0) throw new ConfigurationError(`An Owner ${kind} id is required.`);
}

function clone(value) {
  return value ? structuredClone(value) : undefined;
}

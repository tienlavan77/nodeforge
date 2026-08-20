import { ConfigurationError } from "../../shared/errors.js";

const RESULT_TYPES = new Set(["architecture.completed", "sprint.plan.completed", "ticket.completed", "review.completed", "agent.failed"]);

export function createAgentResultRouter({ bus, resultStore = createResultStore(), nodeId = "NODE" } = {}) {
  if (typeof bus?.subscribe !== "function") throw new ConfigurationError("Agent Result Router requires a Communication Bus.");
  if (typeof resultStore?.append !== "function" || typeof resultStore?.getAll !== "function") throw new ConfigurationError("Agent Result Router requires a result store.");
  const workflows = new Map();
  const processed = new Map();
  bus.subscribe(nodeId, route);

  return Object.freeze({ registerWorkflow, route, getAudit });

  function registerWorkflow(correlationId, handlers) {
    assertId(correlationId, "correlation");
    if (!handlers || typeof handlers !== "object") throw new ConfigurationError("Workflow result handlers are required.");
    for (const [type, handler] of Object.entries(handlers)) {
      if (!RESULT_TYPES.has(type) || typeof handler !== "function") throw new ConfigurationError(`Invalid result handler: ${type}.`);
    }
    if (workflows.has(correlationId)) throw new ConfigurationError(`Workflow already registered: ${correlationId}.`);
    workflows.set(correlationId, Object.freeze({ ...handlers }));
    return correlationId;
  }

  function route(message) {
    assertMessage(message);
    if (processed.has(message.id)) return Object.freeze({ accepted: false, duplicate: true, correlation_id: message.correlation_id });
    const handler = workflows.get(message.correlation_id)?.[message.message_type];
    if (typeof handler !== "function") throw new ConfigurationError(`No workflow route for ${message.message_type}:${message.correlation_id}.`);
    const stored = resultStore.append(structuredClone(message));
    processed.set(message.id, stored);
    const result = handler(structuredClone(stored));
    return Object.freeze({ accepted: true, correlation_id: message.correlation_id, result });
  }

  function getAudit() {
    return resultStore.getAll().map((message) => structuredClone(message));
  }
}

function createResultStore() {
  const records = [];
  const ids = new Set();
  return {
    append(message) {
      if (ids.has(message.id)) throw new ConfigurationError(`Result already audited: ${message.id}.`);
      const stored = Object.freeze(structuredClone(message));
      records.push(stored);
      ids.add(stored.id);
      return structuredClone(stored);
    },
    getAll: () => records.map((record) => structuredClone(record))
  };
}

function assertMessage(message) {
  if (!message || typeof message !== "object" || typeof message.id !== "string" || typeof message.correlation_id !== "string" || !RESULT_TYPES.has(message.message_type) || !message.payload || typeof message.payload !== "object") {
    throw new ConfigurationError("Unknown or invalid Agent result message.");
  }
}

function assertId(id, label) {
  if (typeof id !== "string" || id.length === 0) throw new ConfigurationError(`An Agent ${label} id is required.`);
}

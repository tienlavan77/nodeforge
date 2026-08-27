import { ConfigurationError } from "../shared/errors.js";

const SENSITIVE = /(?:api[_-]?key|credential|secret|password|token|authorization)/i;

// Read-only projection over existing audit authorities. It never persists or mutates records.
export function createConversationAuditHistoryService({ communications, eventStore, history, logReader } = {}) {
  if (typeof communications?.getAll !== "function") throw new ConfigurationError("Conversation Audit History requires a Communication Store.");
  if (eventStore !== undefined && typeof eventStore?.getAll !== "function") throw new ConfigurationError("Conversation Audit History Event Store must provide getAll().");
  if (history !== undefined && typeof history?.getByProject !== "function") throw new ConfigurationError("Conversation Audit History Store must provide getByProject().");

  return Object.freeze({ query });

  function query({ projectId, agentId, conversationId, correlationId, type, cursor, limit = 25, order = "asc" } = {}) {
    if (logReader) {
      return Promise.resolve(logReader({ project_id: projectId, task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, event_name: type })).then((result) => { const items = result.events.map((event, index) => ({ id: event.event_id, kind: event.status === "failed" ? "failure" : "system", sequence: event.sequence ?? index + 1, timestamp: event.timestamp, agent_id: event.source, sender: event.source, receiver: "NODE", conversation_id: event.conversation_id ?? null, correlation_id: event.correlation_id ?? null, type: event.event_name, content: redact(event.payload) }));
      return { items: order === "desc" ? items.reverse() : items, next_cursor: null }; });
    }
    assertId(projectId, "project");
    for (const [value, label] of [[agentId, "agent"], [conversationId, "conversation"], [correlationId, "correlation"], [type, "type"]]) {
      if (value !== undefined) assertId(value, label);
    }
    if (cursor !== undefined && (!Number.isInteger(Number(cursor)) || Number(cursor) < 0)) throw new ConfigurationError("History cursor must be a non-negative integer.");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ConfigurationError("History limit must be between 1 and 100.");
    if (order !== "asc" && order !== "desc") throw new ConfigurationError("History order must be asc or desc.");
    const records = [
      ...communications.getAll().filter((message) => message.project_id === projectId).map(messageRecord),
    ...(eventStore?.getAll() ?? []).filter((event) => (event.project_id ?? event.metadata?.project_id) === projectId).map(eventRecord),
      ...(history?.getByProject(projectId) ?? []).map(historyRecord)
    ].filter((record) => matches(record, { agentId, conversationId, correlationId, type }))
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp) || left.sequence - right.sequence);
    const ordered = order === "desc" ? [...records].reverse() : records;
    const start = cursor === undefined ? 0 : Number(cursor);
    const items = ordered.slice(start, start + limit).map((record) => structuredClone(record));
    return { items, next_cursor: start + items.length < ordered.length ? String(start + items.length) : null };
  }
}

function messageRecord(message, index) {
  return {
    id: message.id, kind: classifyMessage(message), sequence: index, timestamp: message.timestamp,
    agent_id: message.sender.id, sender: message.sender.id, receiver: message.recipient.id,
    conversation_id: message.conversation_id ?? null, correlation_id: message.correlation_id ?? null,
    type: message.message_type, content: redact(message.payload)
  };
}

function eventRecord(event, index) {
  return {
    id: event.event_id, kind: classifyEvent(event), sequence: 100000 + index, timestamp: event.timestamp,
    agent_id: event.metadata.agent_id ?? event.source, sender: event.source, receiver: "NODE",
    conversation_id: event.metadata.conversation_id ?? null, correlation_id: event.metadata.correlation_id ?? null,
    type: event.event_type, content: redact(event.payload)
  };
}

function historyRecord(record, index) {
  return {
    id: record.event_id, kind: record.action.includes("failed") ? "failure" : record.action.includes("completed") ? "completion" : "system",
    sequence: 200000 + index, timestamp: record.timestamp, agent_id: record.actor, sender: record.actor, receiver: "NODE",
    conversation_id: null, correlation_id: null, type: record.action, content: redact({ result: record.result, ...(record.long_term_fact ? { long_term_fact: record.long_term_fact } : {}) })
  };
}

function matches(record, { agentId, conversationId, correlationId, type }) {
  return (!agentId || record.agent_id === agentId || record.sender === agentId || record.receiver === agentId)
    && (!conversationId || record.conversation_id === conversationId)
    && (!correlationId || record.correlation_id === correlationId)
    && (!type || record.type === type);
}

function classifyMessage(message) {
  if (message.sender.role === "project_owner") return "owner";
  if (message.message_type.includes("error") || message.message_type.includes("failed")) return "failure";
  if (message.message_type.includes("completed")) return "completion";
  return message.sender.role === "node" ? "system" : "agent";
}

function classifyEvent(event) {
  if (event.event_type.includes("failed")) return "failure";
  if (event.event_type.includes("completed")) return "completion";
  return "system";
}

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE.test(key) ? "[REDACTED]" : redact(item)]));
}

function assertId(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError(`Conversation Audit History ${label} id is required.`);
}

import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

export function createExecutionEventBus({ validate = () => true, eventStore, clock = () => new Date().toISOString() } = {}) {
  const subscribers = new Map();
  const seen = new Set();
  let sequence = 0;
  return Object.freeze({ publish, subscribe, unsubscribe });

  function subscribe(supervisorId, handler) {
    if (typeof supervisorId !== "string" || !supervisorId || typeof handler !== "function") throw new ConfigurationError("Event subscription requires supervisor_id and handler.");
    const list = subscribers.get(supervisorId) ?? [];
    list.push(handler); subscribers.set(supervisorId, list);
    return () => unsubscribe(supervisorId, handler);
  }
  function unsubscribe(supervisorId, handler) {
    const list = subscribers.get(supervisorId) ?? [];
    const next = list.filter((item) => item !== handler);
    if (next.length) subscribers.set(supervisorId, next); else subscribers.delete(supervisorId);
  }
  async function publish(event) {
    const normalized = { event_id: event.event_id ?? `EVT-${randomUUID()}`, event_type: event.event_type ?? event.type, project_id: event.project_id ?? "PROJECT-NODEFORGE", source: event.source ?? "supervisor", metadata: event.metadata ?? {}, timestamp: event.timestamp ?? clock(), sequence: ++sequence, ...event };
    if (!normalized.supervisor_id || !normalized.task_id) throw new ConfigurationError("Execution event requires task_id and supervisor_id.");
    if (!validate(normalized)) throw new ConfigurationError("Invalid execution event.");
    if (seen.has(normalized.event_id)) return { accepted: false, duplicate: true, event: normalized };
    seen.add(normalized.event_id);
    await eventStore?.append?.(normalized);
    for (const handler of subscribers.get(normalized.supervisor_id) ?? []) await handler(normalized);
    return { accepted: true, event: normalized };
  }
}

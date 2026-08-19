import { ConfigurationError } from "../../shared/errors.js";

export function createHistoryStore({ subscriptions } = {}) {
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") {
    throw new ConfigurationError("History Store requires an Event Subscription Registry.");
  }
  const records = [];
  const subscription = subscriptions.subscribe("*", appendEvent);

  return Object.freeze({ getByProject, getByTask, close });

  function appendEvent(event) {
    const record = Object.freeze({
      event_id: event.event_id,
      actor: event.metadata.actor ?? event.metadata.agent_id ?? event.source,
      action: event.event_type,
      timestamp: event.timestamp,
      project_id: event.metadata.project_id,
      task_id: event.metadata.task_id,
      result: event.payload.result ?? event.payload.status ?? event.payload.outcome ?? "recorded"
    });
    records.push(record);
  }

  function getByProject(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    return records.filter((record) => record.project_id === projectId).map(cloneRecord);
  }

  function getByTask(taskId) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ConfigurationError("A task_id is required.");
    return records.filter((record) => record.task_id === taskId).map(cloneRecord);
  }

  function close() {
    return subscriptions.unsubscribe(subscription);
  }
}

function cloneRecord(record) {
  return { ...record };
}

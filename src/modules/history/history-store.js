import { ConfigurationError } from "../../shared/errors.js";

export function createHistoryStore({ subscriptions } = {}) {
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") {
    throw new ConfigurationError("History Store requires an Event Subscription Registry.");
  }
  const records = [];
  const archive = [];
  const subscription = subscriptions.subscribe("*", appendEvent);

  return Object.freeze({ compact, getByProject, getByTask, getStats, close });

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
    return allRecords().filter((record) => record.project_id === projectId).map(cloneRecord);
  }

  function getByTask(taskId) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ConfigurationError("A task_id is required.");
    return allRecords().filter((record) => record.task_id === taskId).map(cloneRecord);
  }

  function compact({ projectId, taskIds } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || !Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
      throw new ConfigurationError("History compaction requires a project_id and one or more task IDs with completed summaries.");
    }
    const tasks = new Set(taskIds);
    const retained = [];
    let archived = 0;
    for (const record of records) {
      if (record.project_id === projectId && tasks.has(record.task_id)) {
        archive.push(record);
        archived += 1;
      } else retained.push(record);
    }
    records.splice(0, records.length, ...retained);
    return Object.freeze({ project_id: projectId, archived, active_records: records.length, archived_records: archive.length });
  }

  function getStats() {
    return Object.freeze({ active_records: records.length, archived_records: archive.length, total_records: records.length + archive.length });
  }

  function close() {
    return subscriptions.unsubscribe(subscription);
  }

  function allRecords() {
    return [...archive, ...records];
  }
}

function cloneRecord(record) {
  return { ...record };
}

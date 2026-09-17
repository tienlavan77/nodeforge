// Event-sourced history that archives completed task records and serves project or task queries.
import { ConfigurationError } from "../../shared/errors.js";

// Creates an event-sourced history that tracks active and archived records.
export function createHistoryStore({ subscriptions, database, clock = () => new Date() } = {}) {
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") {
    throw new ConfigurationError("History Store requires an Event Subscription Registry.");
  }
  const records = [];
  const archive = [];
  if (database?.run && database?.all) loadArchive();
  const subscription = subscriptions.subscribe("*", appendEvent);

  return Object.freeze({ compact, getByProject, getByTask, getStats, close });

  // Converts a domain event into a historical record.
  function appendEvent(event) {
    const metadata = event?.metadata ?? {};
    const payload = event?.payload ?? {};
    const record = Object.freeze({
      event_id: event?.event_id,
      actor: metadata.actor ?? metadata.agent_id ?? event?.source ?? "node",
      action: event?.event_type,
      timestamp: event?.timestamp,
      project_id: event?.project_id ?? metadata.project_id,
      task_id: metadata.task_id,
      result: payload.result ?? payload.status ?? payload.outcome ?? "recorded",
        ...(typeof payload.long_term_fact === "string" ? { long_term_fact: payload.long_term_fact } : {}),
      tier: "hot"
    });
    records.push(record);
  }

  // Returns records filtered by project identifier.
  function getByProject(projectId) {
    if (typeof projectId !== "string" || projectId.length === 0) throw new ConfigurationError("A project_id is required.");
    return allRecords().filter((record) => record.project_id === projectId).map(cloneRecord);
  }

  // Returns records filtered by task identifier.
  function getByTask(taskId) {
    if (typeof taskId !== "string" || taskId.length === 0) throw new ConfigurationError("A task_id is required.");
    return allRecords().filter((record) => record.task_id === taskId).map(cloneRecord);
  }

  // Archives records for completed tasks and returns archive counts.
  function compact({ projectId, taskIds } = {}) {
    if (typeof projectId !== "string" || projectId.length === 0 || !Array.isArray(taskIds) || taskIds.length === 0 || taskIds.some((taskId) => typeof taskId !== "string" || taskId.length === 0)) {
      throw new ConfigurationError("History compaction requires a project_id and one or more task IDs with completed summaries.");
    }
    const tasks = new Set(taskIds);
    const retained = [];
    let archived = 0;
    for (const record of records) {
      if (record.project_id === projectId && tasks.has(record.task_id)) {
        const archivedRecord = Object.freeze({ ...record, tier: "warm", archived_at: clock().toISOString() });
        archive.push(archivedRecord);
        database?.run?.("INSERT OR REPLACE INTO history_archive (event_id, project_id, task_id, archived_at, tier, record_json) VALUES (?, ?, ?, ?, ?, ?)", [archivedRecord.event_id, archivedRecord.project_id, archivedRecord.task_id ?? null, archivedRecord.archived_at, archivedRecord.tier, JSON.stringify(archivedRecord)]);
        archived += 1;
      } else retained.push(record);
    }
    records.splice(0, records.length, ...retained);
    return Object.freeze({ project_id: projectId, archived, active_records: records.length, archived_records: archived });
  }

  // Returns counts of active and archived records.
  function getStats() {
    return Object.freeze({ active_records: records.length, archived_records: archive.length, total_records: records.length + archive.length });
  }

  // Unsubscribes the history store from its event source.
  function close() {
    return subscriptions.unsubscribe(subscription);
  }

  // Loads previously archived records from the database.
  function loadArchive() {
    database.run("CREATE TABLE IF NOT EXISTS history_archive (event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, archived_at TEXT NOT NULL, tier TEXT NOT NULL, record_json TEXT NOT NULL)");
    for (const row of database.all("SELECT record_json FROM history_archive ORDER BY archived_at, event_id")) {
      const record = JSON.parse(row.record_json);
      archive.push(Object.freeze({ ...record, tier: record.tier ?? "warm" }));
    }
  }

  // Returns combined archived and active records.
  function allRecords() {
    return [...archive, ...records];
  }
}

// Shallow-clones a history record.
function cloneRecord(record) {
  return { ...record };
}

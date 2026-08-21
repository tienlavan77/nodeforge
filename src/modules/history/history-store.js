import { ConfigurationError } from "../../shared/errors.js";

export function createHistoryStore({ subscriptions, database, clock = () => new Date() } = {}) {
  if (typeof subscriptions?.subscribe !== "function" || typeof subscriptions?.unsubscribe !== "function") {
    throw new ConfigurationError("History Store requires an Event Subscription Registry.");
  }
  const records = [];
  const archive = [];
  if (database?.run && database?.all) loadArchive();
  const subscription = subscriptions.subscribe("*", appendEvent);

  return Object.freeze({ compact, getByProject, getByTask, getStats, close });

  function appendEvent(event) {
    const record = Object.freeze({
      event_id: event.event_id,
      actor: event.metadata.actor ?? event.metadata.agent_id ?? event.source,
      action: event.event_type,
      timestamp: event.timestamp,
      project_id: event.project_id ?? event.metadata?.project_id,
      task_id: event.metadata.task_id,
      result: event.payload.result ?? event.payload.status ?? event.payload.outcome ?? "recorded",
        ...(typeof event.payload.long_term_fact === "string" ? { long_term_fact: event.payload.long_term_fact } : {}),
      tier: "hot"
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
        const archivedRecord = Object.freeze({ ...record, tier: "warm", archived_at: clock().toISOString() });
        archive.push(archivedRecord);
        database?.run?.("INSERT OR REPLACE INTO history_archive (event_id, project_id, task_id, archived_at, tier, record_json) VALUES (?, ?, ?, ?, ?, ?)", [archivedRecord.event_id, archivedRecord.project_id, archivedRecord.task_id ?? null, archivedRecord.archived_at, archivedRecord.tier, JSON.stringify(archivedRecord)]);
        archived += 1;
      } else retained.push(record);
    }
    records.splice(0, records.length, ...retained);
    return Object.freeze({ project_id: projectId, archived, active_records: records.length, archived_records: archived });
  }

  function getStats() {
    return Object.freeze({ active_records: records.length, archived_records: archive.length, total_records: records.length + archive.length });
  }

  function close() {
    return subscriptions.unsubscribe(subscription);
  }

  function loadArchive() {
    database.run("CREATE TABLE IF NOT EXISTS history_archive (event_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT, archived_at TEXT NOT NULL, tier TEXT NOT NULL, record_json TEXT NOT NULL)");
    for (const row of database.all("SELECT record_json FROM history_archive ORDER BY archived_at, event_id")) {
      const record = JSON.parse(row.record_json);
      archive.push(Object.freeze({ ...record, tier: record.tier ?? "warm" }));
    }
  }

  function allRecords() {
    return [...archive, ...records];
  }
}

function cloneRecord(record) {
  return { ...record };
}

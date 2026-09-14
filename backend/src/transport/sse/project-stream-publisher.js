import { ConfigurationError } from "../../shared/errors.js";

/** Maps internal watcher/index events to the v1 project-stream event contract. */
export function createProjectStreamPublisher({ projectId, indexDb } = {}) {
  if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Project stream publisher requires a project id.");
  if (typeof indexDb?.all !== "function") throw new ConfigurationError("Project stream publisher requires the Code Index database.");

  return Object.freeze({ project });

  function project(event = {}) {
    if (event.project_id !== projectId || event.indexed === false || event.payload?.indexed === false) return null;
    const operation = event.type ?? event.event_type;
    if (typeof operation !== "string" || !operation) return null;
    if (operation.startsWith("ticket.")) return projectTicket(event, operation);
    if (operation.startsWith("sprint.")) return projectSprint(event, operation);
    const path = event.payload?.path;
    if (typeof path !== "string" || !path) return null;

    if (operation === "watcher.file_deleted" || operation === "watcher.file_removed") {
      return { event_type: "watcher.file_removed", payload: { path, indexed_at: event.timestamp, operation, activity: [`Filesystem change: ${path}`, `Watcher event: ${operation} ${path}`, `Indexer removed: ${path}`] } };
    }
    if (!["watcher.file_created", "watcher.file_modified", "watcher.file_renamed", "watcher.file_indexed", "indexer.indexed", "watcher.indexed"].includes(operation)) return null;

    const indexed = indexDb.all("SELECT path, language, size_bytes, sha256, indexed_at FROM files WHERE path = ?", [path])[0] ?? {};
    return {
      event_type: "watcher.file_indexed",
      payload: {
        path,
        language: indexed.language ?? event.payload?.language ?? null,
        size_bytes: indexed.size_bytes ?? event.payload?.size_bytes ?? null,
        sha256: indexed.sha256 ?? event.payload?.sha256 ?? null,
        indexed_at: indexed.indexed_at ?? event.indexed_at ?? event.timestamp,
        operation,
        activity: [`Filesystem change: ${path}`, `Watcher event: ${operation} ${path}`, `Indexer updated: ${path}`]
      }
    };
  }

  function projectTicket(event, operation) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const ticketId = payload.ticket_id ?? event.task_id;
    if (typeof ticketId !== "string" || !ticketId) return null;
    const eventType = operation === "ticket.status_change" || operation === "ticket.status_changed" ? "ticket.status_changed"
      : operation === "ticket.deleted" ? "ticket.deleted"
        : operation === "ticket.created" || operation === "ticket.creation" ? "ticket.created" : "ticket.updated";
    const projected = { ticket_id: ticketId };
    if (eventType === "ticket.status_changed") {
      projected.previous_status = payload.previous_status ?? payload.from ?? null;
      projected.status = payload.status ?? payload.to ?? null;
      projected.updated_at = payload.updated_at ?? event.timestamp ?? null;
    } else {
      if (payload.ticket && typeof payload.ticket === "object") projected.ticket = payload.ticket;
      if (typeof payload.roadmap_version === "string") projected.roadmap_version = payload.roadmap_version;
      if (payload.sprint_id !== undefined) projected.sprint_id = payload.sprint_id;
      if (payload.updated_at !== undefined || event.timestamp !== undefined) projected.updated_at = payload.updated_at ?? event.timestamp ?? null;
    }
    return { event_type: eventType, payload: projected };
  }

  function projectSprint(event, operation) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const sprintId = payload.sprint_id ?? event.task_id;
    if (typeof sprintId !== "string" || !sprintId) return null;
    const eventType = operation === "sprint.deleted" ? "sprint.deleted" : operation === "sprint.created" ? "sprint.created" : "sprint.updated";
    const projected = { sprint_id: sprintId };
    if (payload.sprint && typeof payload.sprint === "object") projected.sprint = payload.sprint;
    if (payload.sprint_plan && typeof payload.sprint_plan === "object") projected.sprint_plan = payload.sprint_plan;
    if (Array.isArray(payload.ticket_ids)) projected.ticket_ids = payload.ticket_ids;
    if (payload.updated_at !== undefined || event.timestamp !== undefined) projected.updated_at = payload.updated_at ?? event.timestamp ?? null;
    return { event_type: eventType, payload: projected };
  }
}

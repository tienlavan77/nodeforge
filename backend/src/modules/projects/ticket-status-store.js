// Transactional ticket status store with versioned transitions, history, and dependency checks.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { assertTicketStatus, assertTicketStatusTransition } from "./ticket-status.js";

// Creates a transactional ticket status tracker with versioned transitions.
export function createTicketStatusStore({ database, projectId, clock = () => new Date(), createId = () => `STATUS-${randomUUID()}`, onEvent = () => {}, publisher } = {}) {
  if (!database?.run || !database?.all) throw new ConfigurationError("Ticket Status Store requires a database.");
  if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Ticket Status Store requires a project_id.");
  if (typeof clock !== "function" || typeof createId !== "function" || typeof onEvent !== "function" || (publisher !== undefined && typeof publisher.publish !== "function")) throw new ConfigurationError("Invalid Ticket Status Store options.");
  ensureTables();

  return Object.freeze({ create, get, getStatus, updateStatus, listByStatus, getHistory, dependenciesReady, retry, resetDoneForRetry, reconcileTerminalStatus });

  // Creates a pending status entry for a ticket.
  function create(ticketId, details = {}) {
    assertTicketId(ticketId);
    const now = nowIso();
    try {
      database.run("INSERT INTO ticket_status (project_id,ticket_id,status,version,error,details_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)", [projectId, ticketId, "pending", 0, null, JSON.stringify(details), now, now]);
    } catch (error) {
      if (String(error.message).includes("UNIQUE")) throw statusError("STATUS_EXISTS", `Ticket status already exists: ${ticketId}.`);
      throw error;
    }
    return get(ticketId);
  }

  // Returns the current status row for a ticket.
  function get(ticketId) { assertTicketId(ticketId); const row = database.all("SELECT * FROM ticket_status WHERE project_id = ? AND ticket_id = ?", [projectId, ticketId])[0]; return row ? mapRow(row) : undefined; }
  // Returns only the status string for a ticket.
  function getStatus(ticketId) { return get(ticketId)?.status; }

  // Transitions status with optimistic concurrency and history logging.
  function updateStatus(ticketId, nextStatus, details = {}, { expectedCurrentStatus } = {}) {
    assertTicketId(ticketId); assertTicketStatus(nextStatus);
    const current = get(ticketId);
    if (!current) throw statusError("STATUS_NOT_FOUND", `Ticket status not found: ${ticketId}.`);
    if (expectedCurrentStatus !== undefined && current.status !== expectedCurrentStatus) throw statusError("STATUS_CONFLICT", `Ticket status changed from expected ${expectedCurrentStatus}; current is ${current.status}.`);
    assertTicketStatusTransition(current.status, nextStatus);
    const now = nowIso();
    const version = current.version + 1;
    const reason = details?.reason ?? null;
    const error = details?.error ?? null;
    const detailsJson = JSON.stringify(details ?? {});
    const apply = () => {
      const result = database.run("UPDATE ticket_status SET status=?,version=?,error=?,details_json=?,updated_at=? WHERE project_id=? AND ticket_id=? AND status=? AND version=?", [nextStatus, version, error, detailsJson, now, projectId, ticketId, current.status, current.version]);
      if (result.changes !== 1) throw statusError("STATUS_CONFLICT", `Concurrent update detected for ticket: ${ticketId}.`);
      database.run("INSERT INTO ticket_status_history (id,project_id,ticket_id,from_status,to_status,reason,details_json,version,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [createId(), projectId, ticketId, current.status, nextStatus, reason, detailsJson, version, now]);
    };
    if (typeof database.transaction === "function") database.transaction(apply); else apply();
    const updated = get(ticketId);
    emit("ticket.status_change", { project_id: projectId, ticket_id: ticketId, from: current.status, to: nextStatus, version, reason, details, timestamp: now });
    if (nextStatus === "blocked") emit("ticket.dependency_blocked", { project_id: projectId, ticket_id: ticketId, details, timestamp: now });
    if (nextStatus === "pending" && current.status === "failed") emit("ticket.retry", { project_id: projectId, ticket_id: ticketId, timestamp: now });
    return updated;
  }

  // Lists tickets filtered by their current status.
  function listByStatus(status) { assertTicketStatus(status); return database.all("SELECT * FROM ticket_status WHERE project_id=? AND status=? ORDER BY updated_at", [projectId, status]).map(mapRow); }
  // Returns the transition history for a ticket.
  function getHistory(ticketId) { assertTicketId(ticketId); return database.all("SELECT * FROM ticket_status_history WHERE project_id=? AND ticket_id=? ORDER BY version", [projectId, ticketId]).map((row) => ({ ...row, details: parseJson(row.details_json) })); }
  // Checks whether listed dependency tickets are all done.
  function dependenciesReady(taskId, dependencyIds = []) { assertTicketId(taskId); if (!Array.isArray(dependencyIds)) throw new ConfigurationError("dependencyIds must be an array."); const blocked_by = dependencyIds.map((id) => ({ id, status: getStatus(id) ?? "not_found" })).filter(({ status }) => status !== "done"); return { ready: blocked_by.length === 0, blocked_by }; }
  // Reopens a failed or review ticket back to pending.
  function retry(ticketId, details = {}) { const current = get(ticketId); if (!current) throw statusError("STATUS_NOT_FOUND", `Ticket status not found: ${ticketId}.`); if (!["failed", "needs_human_review"].includes(current.status)) throw statusError("STATUS_RETRY_INVALID", `Ticket cannot be retried from ${current.status}.`); return updateStatus(ticketId, "pending", { ...details, reason: details.reason ?? "retry" }, { expectedCurrentStatus: current.status }); }
  // Reconcile a stale runtime completion when the canonical roadmap marks the ticket failed.
  // Resets a stale done ticket to pending for retry.
  function resetDoneForRetry(ticketId, details = {}) { const current = get(ticketId); if (!current) throw statusError("STATUS_NOT_FOUND", `Ticket status not found: ${ticketId}.`); if (current.status !== "done") throw statusError("STATUS_RETRY_INVALID", `Only stale done tickets can be reset: ${ticketId}.`); return transitionWithoutGuard(ticketId, current, "pending", { ...details, reason: details.reason ?? "roadmap_failed_retry" }); }
  // Reconciles a terminal status mismatch from roadmap truth.
  function reconcileTerminalStatus(ticketId, nextStatus, details = {}) {
    const current = get(ticketId);
    if (!current) throw statusError("STATUS_NOT_FOUND", `Ticket status not found: ${ticketId}.`);
    if (!["done", "failed"].includes(nextStatus)) throw statusError("STATUS_INVALID", `Terminal reconciliation requires done or failed: ${nextStatus}.`);
    if (!(["done", "failed"].includes(current.status) && current.status !== nextStatus)) return current;
    return transitionWithoutGuard(ticketId, current, nextStatus, { ...details, reason: details.reason ?? "terminal_reconcile" });
  }
  // Transitions status without normal guard checks, used for reconciliation.
  function transitionWithoutGuard(ticketId, current, nextStatus, details) {
    const now = nowIso(); const version = current.version + 1; const detailsJson = JSON.stringify(details ?? {});
    const apply = () => {
      const result = database.run("UPDATE ticket_status SET status=?,version=?,error=?,details_json=?,updated_at=? WHERE project_id=? AND ticket_id=? AND status=? AND version=?", [nextStatus, version, details?.error ?? null, detailsJson, now, projectId, ticketId, current.status, current.version]);
      if (result.changes !== 1) throw statusError("STATUS_CONFLICT", `Concurrent update detected for ticket: ${ticketId}.`);
      database.run("INSERT INTO ticket_status_history (id,project_id,ticket_id,from_status,to_status,reason,details_json,version,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [createId(), projectId, ticketId, current.status, nextStatus, details.reason ?? null, detailsJson, version, now]);
    };
    if (typeof database.transaction === "function") database.transaction(apply); else apply();
    return get(ticketId);
  }

  // Creates ticket status and history tables.
  function ensureTables() { database.run(`CREATE TABLE IF NOT EXISTS ticket_status (project_id TEXT NOT NULL,ticket_id TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0,error TEXT,details_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(project_id,ticket_id))`); database.run(`CREATE TABLE IF NOT EXISTS ticket_status_history (id TEXT PRIMARY KEY,project_id TEXT NOT NULL,ticket_id TEXT NOT NULL,from_status TEXT,to_status TEXT NOT NULL,reason TEXT,details_json TEXT,version INTEGER NOT NULL,created_at TEXT NOT NULL)`); }
  // Returns the current timestamp as an ISO string.
  function nowIso() { return clock().toISOString(); }
  // Emits a domain event via publisher and local observers.
  function emit(type, payload) {
    const event = { event_id: `EVT-${randomUUID()}`, project_id: projectId, type, timestamp: payload.timestamp ?? nowIso(), payload: { ...payload } };
    try { publisher?.publish(event); } catch { /* publisher failures cannot undo persistence */ }
    try { onEvent({ type, ...payload }); } catch { /* observers cannot break persistence */ }
  }
}

// Validates that a ticket identifier is present.
function assertTicketId(id) { if (typeof id !== "string" || !id) throw new ConfigurationError("ticket_id is required."); }
// Safely parses a JSON string or returns an empty object.
function parseJson(value) { try { return value ? JSON.parse(value) : {}; } catch { return {}; } }
// Maps a database row into a typed status object.
function mapRow(row) { return { project_id: row.project_id, ticket_id: row.ticket_id, status: row.status, version: row.version, error: row.error, details: parseJson(row.details_json), created_at: row.created_at, updated_at: row.updated_at }; }
// Creates a coded error for ticket status operations.
function statusError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

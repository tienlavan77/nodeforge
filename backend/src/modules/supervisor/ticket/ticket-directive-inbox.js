// Business purpose: provides a durable, project-isolated mid-flight directive inbox so the Project Owner, Sprint Leader, Architecture Manager, or Node can steer or gracefully pause a running Coder ticket at the next turn boundary without aborting in-flight tool calls or loosening file scope governance.
// Technical description: persists per-ticket directive queues under .forge/runtime/ticket-directives/<projectHash>/<taskId>.json using acquireTicketFileLock, validates sender roles and instruction bounds, drains pending directives atomically at turn boundaries, and formats validated directives for prompt injection.
import { createHash } from "node:crypto";
import { statePath } from "../../../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const ROOT = statePath("ticket-directives");
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
export const ALLOWED_DIRECTIVE_ROLES = new Set(["project_owner", "sprint_leader", "architecture_manager", "node"]);
export const ALLOWED_DIRECTIVE_KINDS = new Set(["implementation_guidance", "focus_constraint", "pause_after_turn"]);
const MAX_INSTRUCTION_LENGTH = 2000;
const MAX_RETAINED_DIRECTIVES = 8;

// Business purpose: computes a deterministic SHA-256 hex digest for project directory isolation and content-addressed directive IDs.
// Technical description: hashes a UTF-8 string with node:crypto createHash("sha256").
const sha256Hex = (value) => createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");

// Business purpose: constructs a typed ConfigurationError with an attached machine-readable error code for directive validation failures.
// Technical description: attaches the provided error code to a ConfigurationError instance.
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Business purpose: creates a multi-project isolated directive inbox store backed by the project's FileService and cross-process file locks.
// Technical description: exposes enqueue, list, and drainPending operations scoped to (projectId, taskId) with idempotent directive IDs and atomic JSON persistence.
export function createTicketDirectiveInbox({ fileService, projectId, projectRoot, projectLogger = () => {} } = {}) {
  if (!fileService?.readFile || !fileService?.atomicWrite || !fileService?.createLock || !projectId || !projectRoot) {
    throw fail("CONFIGURATION_ERROR", "Ticket directive inbox requires File Service, project ID, and project root.");
  }
  const directory = `${ROOT}/${sha256Hex(projectId)}`;

  // Business purpose: resolves the canonical project-relative storage path for one ticket's directive inbox while rejecting path traversal.
  // Technical description: validates taskId against SAFE_ID and returns the path under the hashed project directory.
  const pathFor = (taskId) => {
    if (typeof taskId !== "string" || !SAFE_ID.test(taskId)) {
      throw fail("DIRECTIVE_TASK_ID_INVALID", "Ticket directive task ID is invalid.");
    }
    return `${directory}/${taskId}.json`;
  };

  return Object.freeze({ enqueue, list, drainPending });

  // Business purpose: reads the persisted directive inbox document for a ticket, returning an empty structure when no directives have been queued yet.
  // Technical description: parses the JSON file at pathFor(taskId), handling ENOENT as an empty inbox and verifying project_id and task_id consistency.
  async function loadRecord(taskId) {
    try {
      const raw = JSON.parse(await fileService.readFile({ path: pathFor(taskId) }));
      if (raw?.project_id && raw.project_id !== projectId) throw fail("DIRECTIVE_PROJECT_CONFLICT", "Directive inbox belongs to a different project.");
      if (raw?.task_id && raw.task_id !== taskId) throw fail("DIRECTIVE_TASK_CONFLICT", "Directive inbox belongs to a different task.");
      return { project_id: projectId, task_id: taskId, directives: Array.isArray(raw?.directives) ? raw.directives : [] };
    } catch (error) {
      if (error.code === "ENOENT") return { project_id: projectId, task_id: taskId, directives: [] };
      throw error;
    }
  }

  // Business purpose: serializes concurrent inbox mutations across processes for the same ticket.
  // Technical description: acquires a ticket file lock on <inbox>.lock before running action and releases it in a finally block.
  async function locked(taskId, action) {
    const lock = await acquireTicketFileLock(fileService, `${pathFor(taskId)}.lock`);
    try { return await action(); }
    finally { await lock.release(); }
  }

  // Business purpose: validates and queues a mid-flight directive for a running or resumable ticket.
  // Technical description: verifies sender role, directive kind, and instruction bounds (1..2000 chars), deduplicates by content-addressed directive_id, optionally supersedes prior pending directives of the same kind, and writes atomically.
  async function enqueue({ taskId, directiveId = null, executionId = null, allowAcrossResume = true, sender, kind = "implementation_guidance", instruction, supersedePending = false } = {}) {
    pathFor(taskId);
    const role = typeof sender?.role === "string" ? sender.role.trim() : "";
    const senderId = typeof sender?.id === "string" && sender.id.trim() ? sender.id.trim() : role;
    if (!ALLOWED_DIRECTIVE_ROLES.has(role)) {
      throw fail("DIRECTIVE_SENDER_UNAUTHORIZED", `Directive sender role '${role || "unknown"}' is not authorized.`);
    }
    if (!ALLOWED_DIRECTIVE_KINDS.has(kind)) {
      throw fail("DIRECTIVE_KIND_INVALID", `Directive kind '${kind ?? "unknown"}' is invalid.`);
    }
    const cleanInstruction = typeof instruction === "string" ? instruction.trim() : "";
    if (!cleanInstruction || cleanInstruction.length > MAX_INSTRUCTION_LENGTH) {
      throw fail("DIRECTIVE_INSTRUCTION_INVALID", "Directive instruction must be 1 to 2000 characters.");
    }
    const id = typeof directiveId === "string" && SAFE_ID.test(directiveId)
      ? directiveId
      : `DIR-${sha256Hex(`${projectId}:${taskId}:${executionId ?? ""}:${role}:${kind}:${cleanInstruction}`).slice(0, 24)}`;
    return locked(taskId, async () => {
      const record = await loadRecord(taskId);
      const existing = record.directives.find((entry) => entry.directive_id === id);
      if (existing) return existing;
      const now = new Date().toISOString();
      if (supersedePending === true) {
        for (const entry of record.directives) {
          if (entry.status === "pending" && entry.kind === kind) {
            entry.status = "superseded";
            entry.superseded_at = now;
          }
        }
      }
      const created = {
        directive_id: id,
        project_id: projectId,
        task_id: taskId,
        execution_id: typeof executionId === "string" && executionId.trim() ? executionId.trim() : null,
        allow_across_resume: allowAcrossResume !== false,
        sender: { id: senderId, role },
        kind,
        instruction: cleanInstruction,
        status: "pending",
        created_at: now,
        delivered_at: null,
        delivered_at_turn: null,
        delivered_receipt_position: null
      };
      record.directives.push(created);
      await fileService.atomicWrite({ path: pathFor(taskId), content: `${JSON.stringify(record)}\n`, replace: true });
      projectLogger({ event_name: "ticket.directive_enqueued", level: "info", status: "started", message: "Ticket mid-flight directive enqueued.", task_id: taskId, source: "ticket-directive-inbox", payload: { directive_id: id, kind, sender_role: role } });
      return created;
    });
  }

  // Business purpose: lists directives for a ticket, optionally filtered by delivery status.
  // Technical description: loads the ticket's inbox record and filters directives by status when provided.
  async function list(taskId, { status = null } = {}) {
    const record = await loadRecord(taskId);
    return status ? record.directives.filter((entry) => entry.status === status) : record.directives;
  }

  // Business purpose: atomically drains all eligible pending directives at an SDK turn boundary so each directive is delivered once.
  // Technical description: marks matching pending directives as delivered with turnCount and receiptPosition metadata, persists only when pending items exist, and flags whether pause_after_turn was requested.
  async function drainPending({ taskId, executionId = null, turnCount = 0, receiptPosition = 0 } = {}) {
    pathFor(taskId);
    return locked(taskId, async () => {
      const record = await loadRecord(taskId);
      const pending = record.directives.filter((entry) => {
        if (entry.status !== "pending") return false;
        if (entry.execution_id && executionId && entry.execution_id !== executionId && entry.allow_across_resume === false) return false;
        return true;
      });
      if (!pending.length) return { directives: [], pauseRequested: false };
      const now = new Date().toISOString();
      for (const entry of pending) {
        entry.status = "delivered";
        entry.delivered_at = now;
        entry.delivered_at_turn = turnCount;
        entry.delivered_receipt_position = receiptPosition;
      }
      await fileService.atomicWrite({ path: pathFor(taskId), content: `${JSON.stringify(record)}\n`, replace: true });
      const pauseRequested = pending.some((entry) => entry.kind === "pause_after_turn");
      projectLogger({ event_name: "ticket.directives_drained", level: "info", status: "success", message: "Drained pending ticket directives at turn boundary.", task_id: taskId, source: "ticket-directive-inbox", payload: { count: pending.length, directive_ids: pending.map((d) => d.directive_id), pause_requested: pauseRequested, turn: turnCount, receipt_position: receiptPosition } });
      return { directives: pending.map((entry) => ({ ...entry })), pauseRequested };
    });
  }
}

// Business purpose: sanitizes delivered directive records stored inside a ticket checkpoint so checkpoints remain compact and free of untrusted fields.
// Technical description: retains at most the last 8 valid directive summaries with bounded instruction text.
export function sanitizeDeliveredDirectives(list) {
  if (!Array.isArray(list)) return [];
  const clean = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = typeof item.directive_id === "string" && SAFE_ID.test(item.directive_id) ? item.directive_id : null;
    const role = typeof (item.role ?? item.sender?.role) === "string" ? (item.role ?? item.sender.role) : null;
    const kind = typeof item.kind === "string" && ALLOWED_DIRECTIVE_KINDS.has(item.kind) ? item.kind : null;
    const instruction = typeof item.instruction === "string" ? item.instruction.trim().slice(0, MAX_INSTRUCTION_LENGTH) : "";
    if (!id || !role || !ALLOWED_DIRECTIVE_ROLES.has(role) || !kind || !instruction) continue;
    clean.push({
      directive_id: id,
      role,
      kind,
      instruction,
      ...(Number.isInteger(item.delivered_at_turn) ? { delivered_at_turn: item.delivered_at_turn } : {})
    });
  }
  return clean.slice(-MAX_RETAINED_DIRECTIVES);
}

// Business purpose: formats drained or retained mid-flight directives into an explicit turn-boundary prompt block that preserves all existing scope and governance gates.
// Technical description: serializes directive metadata and instructions with an invariant guardrail header.
export function formatMidFlightDirectives(directives) {
  const clean = sanitizeDeliveredDirectives(directives);
  if (!clean.length) return "";
  const lines = clean.map((entry) => `- [${entry.directive_id}] (${entry.role} / ${entry.kind}): ${entry.instruction}`);
  return [
    "MID-FLIGHT DIRECTIVES (Validated turn-boundary instructions — apply within existing approved ticket scope and manifest; never bypass tool governance, commit, verification, or report_done):",
    ...lines
  ].join("\n");
}

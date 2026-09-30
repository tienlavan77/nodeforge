// Persists owner decisions for legacy tickets before immutable ticket gates can be enabled.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Binds a disposition to the exact inventory evidence reviewed by its owner.
function fingerprint(ticket) {
  return `sha256:${hash(JSON.stringify(ticket))}`;
}

// Stores explicit migration, cancellation, or human review decisions through File Service.
export function createTicketPipelineDisposition({ projectId, fileService, inventory, projectLogger = () => {} } = {}) {
  if (!projectId || !fileService?.readFile || !fileService?.atomicWrite || !fileService?.createLock || !inventory?.inspect) throw fail("CONFIGURATION_ERROR", "Ticket disposition requires project persistence and inventory.");
  const root = `.forge/runtime/ticket-pipeline-disposition/${hash(projectId)}`;
  return Object.freeze({ decide, inspect, get });

  // Keeps an owner cancellation effective when later runtime activity changes its inventory fingerprint.
  async function get(taskId) {
    if (!SAFE_ID.test(taskId ?? "")) throw fail("TICKET_DISPOSITION_INPUT", "A valid ticket ID is required.");
    try {
      const record = JSON.parse(await fileService.readFile({ path: `${root}/${taskId}.json` }));
      if (record.project_id !== projectId || record.task_id !== taskId) throw fail("TICKET_DISPOSITION_INVALID", "Ticket disposition identity is invalid.");
      return record;
    } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Records an owner decision only against the current inventory snapshot.
  async function decide({ taskId, disposition, actorId, actorRole, evidenceRefs = [], expectedFingerprint } = {}) {
    if (!SAFE_ID.test(taskId ?? "") || !SAFE_ID.test(actorId ?? "") || !["sprint-leader", "human"].includes(actorRole)
      || !["migrated", "cancelled", "needs_human_review"].includes(disposition)
      || !Array.isArray(evidenceRefs) || evidenceRefs.some((ref) => typeof ref !== "string" || !ref.trim())) throw fail("TICKET_DISPOSITION_INPUT", "A valid owner, disposition, and evidence references are required.");
    if (disposition !== "needs_human_review" && evidenceRefs.length === 0) throw fail("TICKET_DISPOSITION_EVIDENCE_REQUIRED", "Migration or cancellation requires evidence references.");
    const path = `${root}/${taskId}.json`;
    const lock = await acquireTicketFileLock(fileService, `${path}.lock`);
    try {
      const current = (await inventory.inspect()).tickets.find((item) => item.task_id === taskId);
      if (!current) throw fail("TICKET_DISPOSITION_NOT_ACTIVE", "Ticket is not in the current legacy inventory.");
      const snapshot = fingerprint(current);
      if (snapshot !== expectedFingerprint) throw fail("TICKET_DISPOSITION_STALE", "Legacy evidence changed after the owner reviewed it.");
      if (disposition === "migrated" && (current.classification !== "migratable" || !current.context || !current.ledger)) throw fail("TICKET_DISPOSITION_MIGRATION_UNPROVEN", "Ticket migration requires complete context and ledger evidence.");
      let prior = null;
      try { prior = JSON.parse(await fileService.readFile({ path })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (prior && prior.inventory_fingerprint === snapshot && prior.disposition === disposition && prior.actor_id === actorId && JSON.stringify(prior.evidence_refs) === JSON.stringify(evidenceRefs)) return prior;
      if (prior) throw fail("TICKET_DISPOSITION_CONFLICT", "A prior owner decision exists; reconcile it explicitly before changing disposition.");
      const record = { project_id: projectId, task_id: taskId, inventory_fingerprint: snapshot, disposition, actor_id: actorId, actor_role: actorRole, evidence_refs: evidenceRefs, decided_at: new Date().toISOString() };
      await fileService.atomicWrite({ path, content: `${JSON.stringify(record)}\n`, replace: false });
      projectLogger({ event_name: "ticket.pipeline_disposition_saved", level: "info", status: "success", message: "Legacy ticket disposition recorded.", task_id: taskId, source: "ticket-pipeline-disposition", payload: { disposition, actor_id: actorId } });
      return record;
    } finally { await lock.release(); }
  }

  // Refreshes inventory and marks missing or stale decisions as enforce blockers.
  async function inspect() {
    const snapshot = await inventory.inspect();
    const tickets = [];
    for (const ticket of snapshot.tickets) {
      let decision = null;
      try { decision = JSON.parse(await fileService.readFile({ path: `${root}/${ticket.task_id}.json` })); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const valid = decision?.project_id === projectId && decision?.task_id === ticket.task_id && decision?.inventory_fingerprint === fingerprint(ticket);
      tickets.push({ task_id: ticket.task_id, classification: ticket.classification, inventory_fingerprint: fingerprint(ticket), disposition: valid ? decision.disposition : null, blocked: !valid || !["migrated", "cancelled"].includes(decision.disposition), reason: !decision ? "undispositioned" : !valid ? "stale_disposition" : decision.disposition === "needs_human_review" ? "human_review_pending" : null });
    }
    return { project_id: projectId, inspected_at: snapshot.inspected_at, tickets };
  }
}

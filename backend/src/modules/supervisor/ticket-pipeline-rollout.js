// Controls project-scoped rollout of immutable ticket gates after legacy evidence is classified.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Persists a project flag and keeps legacy tickets on the observable shadow path by default.
export function createTicketPipelineRollout({ projectId, fileService, inventory, disposition, releaseGate, projectLogger = () => {} } = {}) {
  if (!projectId || !fileService?.readFile || !fileService?.atomicWrite || !fileService?.createLock || !inventory?.inspect) throw fail("CONFIGURATION_ERROR", "Ticket pipeline rollout requires project persistence and inventory.");
  const path = `.forge/runtime/ticket-pipeline-rollout/${hash(projectId)}.json`;
  return Object.freeze({ load, setMode, shadowAudit });

  // Reads the project flag without silently enabling hard gates for old tickets.
  async function load() {
    let record;
    try { record = JSON.parse(await fileService.readFile({ path })); }
    catch (error) { if (error.code === "ENOENT") return { project_id: projectId, mode: "shadow", version: 0 }; throw error; }
    if (record.project_id !== projectId || !["shadow", "enforce"].includes(record.mode) || !Number.isSafeInteger(record.version) || record.version < 1) throw fail("TICKET_PIPELINE_FLAG_INVALID", "Project ticket pipeline flag is invalid.");
    return record;
  }

  // Enables hard gates only after the caller checks the inventory and flag version.
  async function setMode(mode, expectedVersion) {
    if (!["shadow", "enforce"].includes(mode) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw fail("TICKET_PIPELINE_FLAG_INPUT", "Rollout mode and expected version are required.");
    const lock = await acquireTicketFileLock(fileService, `${path}.lock`);
    try {
      const current = await load();
      if (current.version !== expectedVersion) throw fail("TICKET_PIPELINE_FLAG_CONFLICT", "Project rollout flag changed.");
      if (mode === "enforce") {
        if (!releaseGate?.verify) throw fail("TICKET_PIPELINE_RELEASE_REQUIRED", "Enforce requires a signed A1–A5 release decision.");
        const release = await releaseGate.verify({ projectId });
        if (release?.approved !== true || release.project_id !== projectId) throw fail("TICKET_PIPELINE_RELEASE_REQUIRED", "The project has no approved A1–A5 release decision.");
        const result = await inventory.inspect();
        if (result.project_id !== projectId) throw fail("TICKET_PIPELINE_MIGRATION_REQUIRED", "Legacy inventory belongs to a different project.");
        if (!disposition?.inspect) throw fail("TICKET_PIPELINE_DISPOSITION_REQUIRED", "Enforce requires an explicit legacy disposition service.");
        const decisions = await disposition.inspect();
        const decisionIds = new Set(decisions.tickets.map((ticket) => ticket.task_id));
        if (decisions.project_id !== projectId || decisions.tickets.length !== result.tickets.length || result.tickets.some((ticket) => !decisionIds.has(ticket.task_id)) || decisions.tickets.some((ticket) => ticket.blocked)) throw fail("TICKET_PIPELINE_DISPOSITION_REQUIRED", "All active legacy tickets require current owner dispositions before hard gates can be enabled.");
      }
      const next = { project_id: projectId, mode, version: current.version + 1, updated_at: new Date().toISOString() };
      await fileService.atomicWrite({ path, content: `${JSON.stringify(next)}\n`, replace: true });
      projectLogger({ event_name: "ticket.pipeline_rollout_changed", level: "info", status: "success", message: "Project ticket pipeline mode changed.", source: "ticket-pipeline-rollout", payload: { project_id: projectId, mode, version: next.version } });
      return next;
    } finally { await lock.release(); }
  }

  // Records only classification counts while legacy gates remain authoritative.
  async function shadowAudit() {
    const result = await inventory.inspect();
    const counts = Object.fromEntries(["migratable", "stale", "human-review-required"].map((status) => [status, result.tickets.filter((ticket) => ticket.classification === status).length]));
    projectLogger({ event_name: "ticket.pipeline_shadow_audit", level: "info", status: "success", message: "Legacy ticket evidence classified before immutable gates.", source: "ticket-pipeline-rollout", payload: { project_id: projectId, count: result.tickets.length, classifications: counts } });
    return { project_id: projectId, count: result.tickets.length, classifications: counts };
  }
}

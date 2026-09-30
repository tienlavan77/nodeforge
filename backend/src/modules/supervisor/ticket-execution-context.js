// Persists the ticket identity chain so dispatch and recovery agree on one source revision.
import { createHash } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "./ticket-file-lock.js";
import { verifyTicketBaseline } from "./ticket-baseline-guard.js";

const ROOT = ".forge/runtime/ticket-execution-contexts";
const STATES = new Set(["created", "coding", "committed", "verified", "reviewing", "integrating", "terminal"]);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fail = (code, message) => Object.assign(new ConfigurationError(message), { code });

// Stores one versioned ticket context through Forge File Service and a cross-process lock.
export function createTicketExecutionContextStore({ fileService, projectId, projectRoot, projectLogger = () => {} } = {}) {
  if (!fileService?.readFile || !fileService?.atomicWrite || !fileService?.createLock || !projectId || !projectRoot) throw fail("CONFIGURATION_ERROR", "Ticket execution context requires File Service, project ID, and root.");
  const directory = `${ROOT}/${digest(projectId).slice(7)}`;
  const pathFor = (taskId) => {
    if (!SAFE_ID.test(taskId ?? "")) throw fail("TICKET_CONTEXT_ID_INVALID", "Ticket context task ID is unsafe.");
    return `${directory}/${taskId}.json`;
  };
  return Object.freeze({ create, load, update, syncManifest, manifestIdentity });

  // Loads a persisted context after retry or process restart.
  async function load(taskId) {
    try { return JSON.parse(await fileService.readFile({ path: pathFor(taskId) })); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  // Creates the context once before dispatch, rejecting a changed owner or baseline.
  async function create({ taskId, supervisorId, baseSha, baseline = null }) {
    if (!supervisorId || !/^[a-f0-9]{40,64}$/i.test(baseSha ?? "")) throw fail("TICKET_CONTEXT_INPUT", "Context requires Supervisor ownership and a Git baseline SHA.");
    return locked(taskId, async () => {
      const existing = await load(taskId);
      if (existing) {
        if (existing.supervisor_id !== supervisorId || existing.base_sha !== baseSha || existing.project_id !== projectId || JSON.stringify(existing.approved_baseline ?? null) !== JSON.stringify(baseline)) throw fail("TICKET_CONTEXT_CONFLICT", "Ticket context owner or baseline changed.");
        return existing;
      }
      const now = new Date().toISOString();
      const identity = manifestIdentity({ revision: 0, entries: {} });
      const record = { task_id: taskId, project_id: projectId, supervisor_id: supervisorId, base_sha: baseSha, execution_root: "project-root", ...(baseline ? { approved_baseline: baseline } : {}), source_revision: identity.source_revision, manifest_paths: [], manifest_sha: identity.manifest_sha, verification_artifact_id: null, review_commit_sha: null, state: "created", version: 1, created_at: now, updated_at: now };
      await fileService.atomicWrite({ path: pathFor(taskId), content: `${JSON.stringify(record)}\n`, replace: false });
      log("created", record);
      return record;
    });
  }

  // Advances a Node-owned transition only when the expected persisted version still matches.
  async function update(taskId, expectedVersion, patch) {
    return locked(taskId, async () => {
      const current = await load(taskId);
      if (!current) throw fail("TICKET_CONTEXT_MISSING", "Ticket context does not exist.");
      if (current.version !== expectedVersion) throw fail("TICKET_CONTEXT_VERSION_CONFLICT", "Ticket context version changed.");
      if (!patch || typeof patch !== "object" || Object.keys(patch).some((key) => !["state", "source_revision", "manifest_paths", "manifest_sha", "verification_artifact_id", "review_commit_sha"].includes(key))) throw fail("TICKET_CONTEXT_PATCH_INVALID", "Ticket context update contains an unauthorized field.");
      if (patch.state && !STATES.has(patch.state)) throw fail("TICKET_CONTEXT_STATE_INVALID", "Ticket context state is invalid.");
      if (current.state === "terminal" && patch.state && patch.state !== "terminal") throw fail("TICKET_CONTEXT_TERMINAL", "Terminal ticket context cannot reopen.");
      const next = { ...current, ...patch, version: current.version + 1, updated_at: new Date().toISOString() };
      await fileService.atomicWrite({ path: pathFor(taskId), content: `${JSON.stringify(next)}\n`, replace: true });
      log("updated", next);
      return next;
    });
  }

  // Finalizes the manifest identity from the durable ledger rather than agent-supplied paths.
  async function syncManifest(taskId, manifest) {
    const identity = manifestIdentity(manifest);
    return locked(taskId, async () => {
      const current = await load(taskId);
      if (!current) throw fail("TICKET_CONTEXT_MISSING", "Ticket context does not exist.");
      if (current.approved_baseline && Object.keys(manifest.entries).some((path) => !(path in current.approved_baseline.file_checksums))) throw fail("TICKET_BASELINE_SCOPE", "Ticket ledger includes a path outside the approved baseline manifest.");
      if (current.source_revision === identity.source_revision && current.manifest_sha === identity.manifest_sha) return current;
      if (["integrating", "terminal"].includes(current.state)) throw fail("TICKET_CONTEXT_FROZEN", "Ticket manifest is frozen.");
      const next = { ...current, ...identity, state: "coding", verification_artifact_id: null, review_commit_sha: null, version: current.version + 1, updated_at: new Date().toISOString() };
      await fileService.atomicWrite({ path: pathFor(taskId), content: `${JSON.stringify(next)}\n`, replace: true });
      log("manifest_synced", next);
      return next;
    });
  }

  // Hashes sorted path and before/after identities so replay produces the same revision.
  function manifestIdentity(manifest) {
    if (!Number.isSafeInteger(manifest?.revision) || manifest.revision < 0 || !manifest.entries || typeof manifest.entries !== "object") throw fail("TICKET_MANIFEST_INVALID", "Ticket ledger manifest is invalid.");
    const manifestPaths = Object.keys(manifest.entries).sort();
    const entries = manifestPaths.map((path) => ({ path, before_sha: manifest.entries[path].initial_sha ?? null, after_sha: manifest.entries[path].latest_sha ?? null }));
    const manifestSha = digest(JSON.stringify(entries));
    return { source_revision: digest(JSON.stringify({ revision: manifest.revision, manifest_sha: manifestSha })), manifest_paths: manifestPaths, manifest_sha: manifestSha };
  }

  // Serializes context creation and compare-and-swap updates across API workers.
  async function locked(taskId, action) {
    const lock = await acquireTicketFileLock(fileService, `${pathFor(taskId)}.lock`);
    try { return await action(); } finally { await lock.release(); }
  }

  // Emits metadata only so source text never enters project logs.
  function log(phase, record) {
    projectLogger({ event_name: `ticket.context_${phase}`, level: "info", status: "success", message: `Ticket execution context ${phase}.`, task_id: record.task_id, source: "ticket-execution-context", payload: { version: record.version, state: record.state, source_revision: record.source_revision, manifest_sha: record.manifest_sha, path_count: record.manifest_paths.length } });
  }
}

// Creates a context before Coder dispatch while refusing silent migration of old ticket changes.
export async function prepareTicketExecutionContext({ workspace, taskId, supervisorId, ticket }) {
  if (!workspace?.executionContexts) return null;
  const existing = await workspace.executionContexts.load(taskId);
  const manifest = await workspace.changeLedger.snapshot();
  const baseline = taskId === "NF-PIPE-ERR-005-A5-R2" ? await verifyTicketBaseline({ workspace, taskId, supervisorId, ticket, existing }) : null;
  if (!existing && (manifest.revision > 0 || Object.keys(manifest.commits).length)) throw fail("TICKET_CONTEXT_MIGRATION_REQUIRED", "Existing ticket changes require explicit context migration before dispatch.");
  await workspace.executionContexts.create({ taskId, supervisorId, baseSha: workspace.base_commit, baseline });
  return workspace.executionContexts.syncManifest(taskId, manifest);
}

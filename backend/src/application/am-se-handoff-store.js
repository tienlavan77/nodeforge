// Business purpose: persists the durable state and round-by-round history of Architecture Manager to System Engineer automatic plan handoffs so multi-round implementation and verification loops survive restarts and remain auditable per project.
// Technical description: stores JSON handoff records under .forge/runtime/nf/se-handoffs/<projectId>/<handoffId>.json through the project FileService with status validation and lookup helpers.
import { randomUUID } from "node:crypto";
import { statePath } from "../infrastructure/filesystem/forge-paths.js";
import { acquireTicketFileLock } from "../modules/supervisor/ticket/ticket-file-lock.js";
import { ConfigurationError } from "../shared/errors.js";

const VALID_STATUSES = new Set(["critiquing", "running", "rv_reviewing", "reviewing", "am_reviewing", "completed", "paused", "failed"]);
const VALID_PHASES = new Set(["plan_critique", "sl_handoff", "implementation"]);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;

// Business purpose: constructs a typed ConfigurationError with a stable error code for handoff persistence failures.
// Technical description: attaches the error code and HTTP status code to a ConfigurationError instance.
function storeError(code, message, statusCode = 400) {
  return Object.assign(new ConfigurationError(message), { code, statusCode });
}

// Business purpose: creates a project-scoped persistence store for AM to SE handoff sessions.
// Technical description: provides create, get, update, and findByPlanId operations backed by atomic JSON files in the project runtime directory.
export function createAmSeHandoffStore({ projectId, fileService } = {}) {
  if (!projectId || !fileService?.readFile || !fileService?.atomicWrite) {
    throw storeError("HANDOFF_STORE_UNAVAILABLE", "AM-SE handoff store requires projectId and FileService.", 503);
  }
  const baseDir = statePath("nf", "se-handoffs", projectId);

  // Business purpose: resolves the project-relative file path for one handoff record while preventing path traversal.
  // Technical description: validates handoffId against SAFE_ID and joins it under the project's se-handoffs runtime directory.
  function pathFor(handoffId) {
    if (typeof handoffId !== "string" || !SAFE_ID.test(handoffId)) {
      throw storeError("HANDOFF_ID_INVALID", "Handoff identifier is invalid.");
    }
    return `${baseDir}/${handoffId}.json`;
  }

  // Business purpose: creates and persists a new AM to SE critique and handoff record starting in the plan_critique phase.
  // Technical description: initializes the handoff metadata, sets phase to plan_critique and status to critiquing, and writes the JSON file atomically.
  async function create({
    handoffId = `HANDOFF-${projectId}-${randomUUID()}`,
    planId,
    planRevision = 1,
    planSha256,
    planSourcePath,
    deliveryTarget = "se",
    approvalMode = "manual_panel_approval",
    sourceKind = "conversation",
    sourceFilePath = null,
    workspaceScopePaths = null,
    amAgentId,
    seAgentId,
    rvAgentId,
    amConversationId,
    seConversationId,
    rvConversationId,
    phase = "plan_critique",
    status = "critiquing",
    critiqueRound = 1,
    maxCritiqueRounds = 2,
    round = 0,
    maxRounds = 5
  } = {}) {
    pathFor(handoffId);
    if (!planId || !planSha256 || !planSourcePath) {
      throw storeError("HANDOFF_PLAN_REQUIRED", "Handoff creation requires planId, planSha256, and planSourcePath.");
    }
    const now = new Date().toISOString();
    const record = {
      handoff_id: handoffId,
      project_id: projectId,
      plan_id: planId,
      plan_revision: planRevision,
      plan_sha256: planSha256,
      plan_source_path: planSourcePath,
      delivery_target: deliveryTarget === "sl" ? "sl" : "se",
      approval_mode: ["explicit_owner_command", "existing_decision", "manual_panel_approval"].includes(approvalMode) ? approvalMode : "manual_panel_approval",
      source_kind: sourceKind,
      source_file_path: sourceFilePath ?? null,
      workspace_scope_paths: Array.isArray(workspaceScopePaths) ? [...new Set(workspaceScopePaths)].sort() : [],
      am_agent_id: amAgentId ?? "architecture-manager",
      se_agent_id: seAgentId ?? "system-engineer",
      rv_agent_id: rvAgentId ?? "reviewer",
      am_conversation_id: amConversationId ?? null,
      se_conversation_id: seConversationId ?? null,
      rv_conversation_id: rvConversationId ?? null,
      phase: VALID_PHASES.has(phase) ? phase : "plan_critique",
      status: VALID_STATUSES.has(status) ? status : "critiquing",
      critique_round: Number.isInteger(critiqueRound) && critiqueRound > 0 ? critiqueRound : 1,
      max_critique_rounds: Number.isInteger(maxCritiqueRounds) && maxCritiqueRounds > 0 ? maxCritiqueRounds : 2,
      round: Number.isInteger(round) && round >= 0 ? round : 0,
      max_rounds: Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : 5,
      history: [],
      critique_checkpoint: null,
      created_at: now,
      updated_at: now
    };
    const claim = await acquireTicketFileLock(fileService, `${pathFor(handoffId)}.lock`);
    try {
      if (await get(handoffId)) throw storeError("HANDOFF_ALREADY_EXISTS", "Handoff already exists; resume by its ID instead.", 409);
      await fileService.atomicWrite({ path: pathFor(handoffId), content: `${JSON.stringify(record, null, 2)}\n`, replace: false });
      return record;
    } finally { await claim.release(); }
  }

  // Business purpose: loads an existing handoff session by its identifier.
  // Technical description: reads and parses the JSON record from disk, returning null when the file does not exist.
  async function get(handoffId) {
    try {
      return JSON.parse(await fileService.readFile({ path: pathFor(handoffId) }));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  // Business purpose: updates the state, phase, round counter, or history of an active handoff session.
  // Technical description: merges the patch into the stored record, validates the status and phase enums, updates updated_at, and writes atomically.
  async function update(handoffId, patch = {}) {
    const claim = await acquireTicketFileLock(fileService, `${pathFor(handoffId)}.lock`);
    try {
      const current = await get(handoffId);
      if (current?.checkpoint) throw storeError("HANDOFF_CHECKPOINT_TRANSITION_REQUIRED", "Checkpointed handoffs require a guarded transition.", 409);
      if (!current) throw storeError("HANDOFF_NOT_FOUND", `Handoff session not found: ${handoffId}.`, 404);
      if (patch.status !== undefined && !VALID_STATUSES.has(patch.status)) {
        throw storeError("HANDOFF_STATUS_INVALID", `Invalid handoff status: ${patch.status}.`);
      }
      if (patch.phase !== undefined && !VALID_PHASES.has(patch.phase)) {
        throw storeError("HANDOFF_PHASE_INVALID", `Invalid handoff phase: ${patch.phase}.`);
      }
      const next = {
        ...current,
        ...patch,
        handoff_id: current.handoff_id,
        project_id: current.project_id,
        plan_id: current.plan_id,
        updated_at: new Date().toISOString()
      };
      await fileService.atomicWrite({ path: pathFor(handoffId), content: `${JSON.stringify(next, null, 2)}\n`, replace: true });
      return next;
    } finally { await claim.release(); }
  }

  // Business purpose: serializes durable step transitions across concurrent handoff resume requests.
  // Technical description: holds a project-scoped file claim while validating the generation and persisting a single successor record.
  async function transition(handoffId, expectedGeneration, transform) {
    const claim = await acquireTicketFileLock(fileService, `${pathFor(handoffId)}.lock`);
    try {
      const current = await get(handoffId);
      if (!current) throw storeError("HANDOFF_NOT_FOUND", "Handoff not found.", 404);
      const currentGeneration = current.checkpoint?.generation ?? current.critique_checkpoint?.generation ?? 0;
      if (currentGeneration !== expectedGeneration) throw storeError("HANDOFF_STALE", "Handoff checkpoint changed.", 409);
      const next = await transform(current);
      if (!next || next.handoff_id !== current.handoff_id || next.project_id !== current.project_id || next.plan_id !== current.plan_id) throw storeError("HANDOFF_TRANSITION_INVALID", "Invalid handoff transition.", 409);
      if (current.checkpoint?.plan_locked && (!next.checkpoint?.plan_locked || next.plan_revision !== current.plan_revision || next.plan_sha256 !== current.plan_sha256 || next.plan_source_path !== current.plan_source_path)) throw storeError("HANDOFF_PLAN_LOCKED", "Execution plan identity cannot change.", 409);
      if (next.checkpoint) next.checkpoint = { ...next.checkpoint, generation: expectedGeneration + 1 };
      else if (next.critique_checkpoint) next.critique_checkpoint = { ...next.critique_checkpoint, generation: expectedGeneration + 1 };
      next.updated_at = new Date().toISOString();
      await fileService.atomicWrite({ path: pathFor(handoffId), content: `${JSON.stringify(next, null, 2)}\n`, replace: true });
      return next;
    } finally { await claim.release(); }
  }

  // Business purpose: lists persisted handoffs so the Owner UI can show durable AM-SE-RV recovery state after reload.
  // Technical description: reads only project-scoped JSON records, ignores no malformed state, and returns newest records first without mutating them.
  async function list() {
    const paths = await fileService.listFiles({ glob: `${baseDir}/*.json` });
    const records = [];
    for (const path of paths) {
      try {
        const record = JSON.parse(await fileService.readFile({ path }));
        if (record?.project_id === projectId) records.push(record);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    return records.sort((left, right) => String(right.updated_at ?? "").localeCompare(String(left.updated_at ?? "")));
  }

  return Object.freeze({ create, get, list, update, transition, pathFor });
}

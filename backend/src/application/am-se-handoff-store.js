// Business purpose: persists the durable state and round-by-round history of Architecture Manager to System Engineer automatic plan handoffs so multi-round implementation and verification loops survive restarts and remain auditable per project.
// Technical description: stores JSON handoff records under .forge/runtime/nf/se-handoffs/<projectId>/<handoffId>.json through the project FileService with status validation and lookup helpers.
import { randomUUID } from "node:crypto";
import { statePath } from "../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../shared/errors.js";

const VALID_STATUSES = new Set(["critiquing", "running", "reviewing", "completed", "paused", "failed"]);
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
    sourceKind = "conversation",
    sourceFilePath = null,
    amAgentId,
    seAgentId,
    amConversationId,
    seConversationId,
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
      source_kind: sourceKind,
      source_file_path: sourceFilePath ?? null,
      am_agent_id: amAgentId ?? "architecture-manager",
      se_agent_id: seAgentId ?? "system-engineer",
      am_conversation_id: amConversationId ?? null,
      se_conversation_id: seConversationId ?? null,
      phase: VALID_PHASES.has(phase) ? phase : "plan_critique",
      status: VALID_STATUSES.has(status) ? status : "critiquing",
      critique_round: Number.isInteger(critiqueRound) && critiqueRound > 0 ? critiqueRound : 1,
      max_critique_rounds: Number.isInteger(maxCritiqueRounds) && maxCritiqueRounds > 0 ? maxCritiqueRounds : 2,
      round: Number.isInteger(round) && round >= 0 ? round : 0,
      max_rounds: Number.isInteger(maxRounds) && maxRounds > 0 ? maxRounds : 5,
      history: [],
      created_at: now,
      updated_at: now
    };
    await fileService.atomicWrite({ path: pathFor(handoffId), content: `${JSON.stringify(record, null, 2)}\n`, replace: true });
    return record;
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
    const current = await get(handoffId);
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
  }

  return Object.freeze({ create, get, update, pathFor });
}

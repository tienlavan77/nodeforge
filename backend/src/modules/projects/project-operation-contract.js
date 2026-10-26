// Shared contract for durable project lifecycle operations (O3 foundation).
// Business purpose: a Create/Add lifecycle intent must survive crashes and restarts, so intent,
// execution attempt, committed membership and final outcome are kept as one revisioned snapshot
// with explicit stage rules. Technical description: this module owns the operation schema vocabulary
// (stages, statuses, kinds), request fingerprinting, the validated stage transition table and a
// dependency-free snapshot validator mirroring schemas/project/project-operation.schema.json.
import { createHash } from "node:crypto";

export const OPERATION_ID_PREFIX = "OPRO-";
export const OPERATION_KINDS = Object.freeze(["create", "add"]);
export const OPERATION_STAGES = Object.freeze(["intended", "attempted", "committed", "settled", "abandoned"]);
export const OPERATION_STATUSES = Object.freeze(["pending", "running", "succeeded", "failed", "cancelled"]);

// Stage adjacency approved for lifecycle operations: an intent may only move forward through one
// attempt, membership commit and settlement; a failed or cancelled intent may only abandon before
// commit, so a committed Create can never be silently unwound by a later transition.
export const OPERATION_STAGE_TRANSITIONS = Object.freeze({
  intended: Object.freeze(["attempted", "abandoned"]),
  attempted: Object.freeze(["committed", "abandoned"]),
  committed: Object.freeze(["settled"]),
  settled: Object.freeze([]),
  abandoned: Object.freeze([])
});

// Builds the request fingerprint that makes reconciliation possible: two submits sharing a request
// key are the same logical request only when kind, canonical root and known project identity match.
export function computeRequestFingerprint({ kind, root, projectId = null } = {}) {
  return createHash("sha256").update(JSON.stringify({ kind, root, projectId: projectId ?? null })).digest("hex");
}

// Rejects stage moves outside the approved table with a deterministic transition_invalid error.
export function assertStageTransition(fromStage, toStage) {
  const allowed = OPERATION_STAGE_TRANSITIONS[fromStage] ?? [];
  if (!allowed.includes(toStage)) {
    throw Object.assign(new Error(`Invalid operation stage transition: ${fromStage} -> ${toStage}.`), {
      code: "transition_invalid", retryable: false
    });
  }
}

// Validates one persisted snapshot against the operation schema without AJV so the store can
// refuse corrupt files during restart reconciliation instead of trusting them.
export function validateOperationSnapshot(snapshot) {
  const failure = (field, reason) => Object.assign(new Error(`Invalid operation snapshot: ${field} ${reason}.`), { code: "snapshot_invalid" });
  if (!snapshot || typeof snapshot !== "object") throw failure("record", "is not an object");
  if (typeof snapshot.operation_id !== "string" || !/^OPRO-[A-Za-z0-9][A-Za-z0-9_-]*$/.test(snapshot.operation_id)) throw failure("operation_id", "must be OPRO-prefixed");
  if (typeof snapshot.request_key !== "string" || !snapshot.request_key || snapshot.request_key.length > 256) throw failure("request_key", "must be a short non-empty string");
  if (typeof snapshot.request_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.request_fingerprint)) throw failure("request_fingerprint", "must be sha256 hex");
  if (!OPERATION_KINDS.includes(snapshot.kind)) throw failure("kind", "must be create or add");
  if (typeof snapshot.root !== "string" || !snapshot.root) throw failure("root", "must be non-empty");
  if (snapshot.project_id !== undefined && !/^PROJECT-[A-Za-z0-9_-]+$/.test(snapshot.project_id)) throw failure("project_id", "must be PROJECT-prefixed when present");
  if (!Number.isSafeInteger(snapshot.attempt) || snapshot.attempt < 0) throw failure("attempt", "must be a non-negative integer");
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) throw failure("revision", "must be a non-negative integer");
  if (!OPERATION_STAGES.includes(snapshot.stage)) throw failure("stage", "must be a known stage");
  if (!OPERATION_STATUSES.includes(snapshot.status)) throw failure("status", "must be a known status");
  if (!snapshot.result && snapshot.stage !== "settled" && ["succeeded", "failed", "cancelled"].includes(snapshot.status)) {
    throw failure("status", "terminal without result");
  }
  if (snapshot.stage === "settled" && !snapshot.result) throw failure("result", "settled without outcome");
  const counters = snapshot.counters;
  if (!counters || !Number.isSafeInteger(counters.transitions) || counters.transitions < 0 ||
      !Number.isSafeInteger(counters.attempts) || counters.attempts < 0) throw failure("counters", "must be non-negative");
  const timestamps = snapshot.timestamps;
  const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
  if (!timestamps || !isoTime.test(timestamps.created_at ?? "") || !isoTime.test(timestamps.updated_at ?? "")) {
    throw failure("timestamps", "created_at and updated_at must be UTC timestamps");
  }
  if (snapshot.diagnostic !== undefined) {
    const d = snapshot.diagnostic;
    if (!d || typeof d.code !== "string" || !d.code || typeof d.message !== "string" || !d.message) throw failure("diagnostic", "requires code and message");
  }
}

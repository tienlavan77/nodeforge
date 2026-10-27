// Validates the additive operation progress contract independently from lifecycle stage
// transitions. Invalid percentages, counters, attempt identities or function definitions are
// rejected before durable snapshots can publish misleading indexing success.
import { FUNCTION_KINDS, INDEX_STAGES } from "./index-progress.js";

// Checks the bounded progress vocabulary and reconciliation invariants on every persisted
// snapshot, keeping store reads fail closed when progress evidence is corrupt or stale.
export function validateIndexProgress(progress, attempt) {
  const invalid = () => { throw Object.assign(new Error("Invalid index progress snapshot."), { code: "snapshot_invalid" }); };
  if (!progress || !INDEX_STAGES.includes(progress.stage) || !["running", "succeeded", "failed"].includes(progress.status)) invalid();
  if (!Number.isSafeInteger(progress.attempt) || progress.attempt < 1 || (attempt !== undefined && progress.attempt !== attempt)) invalid();
  if (!Number.isSafeInteger(progress.revision) || progress.revision < 0) invalid();
  if (progress.progress?.mode !== "indeterminate" || ["total", "percent", "eta"].some((key) => progress.progress[key] !== null)) invalid();
  if (!progress.counters || ["discovered", "eligible", "indexed", "unchanged", "unsupported", "ignored", "failed", "deleted"]
    .some((key) => !Number.isSafeInteger(progress.counters[key]) || progress.counters[key] < 0)) invalid();
  if (!progress.stages || INDEX_STAGES.some((stage) => !["pending", "running", "completed", "failed"].includes(progress.stages[stage]))) invalid();
  if (!Array.isArray(progress.failures) || progress.failures.length !== progress.counters.failed) invalid();
  if (progress.failures.some((failure) => typeof failure.path !== "string" || typeof failure.marker !== "string" ||
    typeof failure.message !== "string" || (failure.resolved !== undefined && typeof failure.resolved !== "boolean"))) invalid();
  if (progress.status === "succeeded" && (progress.failures.some((failure) => !failure.resolved) || !progress.checkpoint)) invalid();
  if (progress.checkpoint && ["version", "files", "functions"].some((key) => !Number.isSafeInteger(progress.checkpoint[key]) || progress.checkpoint[key] < 0)) invalid();
  if (!progress.embedding || !["pending", "running", "succeeded", "failed"].includes(progress.embedding.status) ||
    ["pending", "processing", "succeeded", "failed"].some((key) => !Number.isSafeInteger(progress.embedding[key]) || progress.embedding[key] < 0)) invalid();
  if (JSON.stringify(progress.function_kinds) !== JSON.stringify(FUNCTION_KINDS)) invalid();
}

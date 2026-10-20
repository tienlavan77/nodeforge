// Persists resumable agent execution checkpoints to the file service under .forge/runtime.
import { ConfigurationError } from "../../shared/errors.js";
import { acquireTicketFileLock } from "../supervisor/ticket-file-lock.js";

// Creates a checkpoint store backed by File Service for save/load/complete lifecycle.
export function createAgentExecutionCheckpointStore({ fileService, root = ".forge/runtime/agent-checkpoints", reviewRoot = ".forge/runtime/reviewer-checkpoints", onSaved } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Agent execution checkpoint store requires File Service persistence.");
  return Object.freeze({ save, load, complete, clear, listPending, saveReview, loadReview, completeReview, clearReview, listReviewPending });

  async function save(checkpoint) {
    if (!checkpoint?.task_id) throw new ConfigurationError("Agent execution checkpoint requires task_id.");
    const record = { ...checkpoint, updated_at: new Date().toISOString() };
    await fileService.atomicWrite({ path: pathFor(checkpoint.task_id), content: `${JSON.stringify(record)}\n`, replace: true });
    await onSaved?.(record);
    return record;
  }

  async function load(taskId) {
    try { return JSON.parse(await fileService.readFile({ path: pathFor(taskId) })); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }

  async function complete(taskId, details = {}) {
    const current = await load(taskId);
    const record = { ...(current ?? { task_id: taskId }), ...details, task_id: taskId, status: "completed", completed_at: new Date().toISOString() };
    return save(record);
  }
  async function clear(taskId) {
    await fileService.deleteFile?.({ path: pathFor(taskId) }).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    return true;
  }

  async function listPending() {
    const out = [];
    if (typeof fileService.listFiles !== "function") return out;
    for (const filePath of await fileService.listFiles({ glob: `${root}/*.json` })) {
      try {
        const checkpoint = JSON.parse(await fileService.readFile({ path: filePath }));
        if (!["completed", "blocked"].includes(checkpoint.status) || (checkpoint.status === "blocked" && Boolean(checkpoint.blocker_recovery))) out.push(checkpoint);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return out;
  }

  // Persists the independent Reviewer lifecycle separately from the Coder checkpoint.
  async function saveReview(checkpoint) {
    if (!checkpoint?.task_id) throw new ConfigurationError("Agent execution checkpoint requires task_id.");
    const path = pathFor(checkpoint.task_id, reviewRoot);
    const lock = fileService.createLock ? await acquireTicketFileLock(fileService, `${path}.lock`) : null;
    try {
      const current = await loadReview(checkpoint.task_id);
      if (current?.status === "completed" && current.verdict === "approved") return current;
      const sameAttempt = current && (!checkpoint.request_id || !current.request_id || current.request_id === checkpoint.request_id);
      const merged = sameAttempt ? { ...current, ...checkpoint } : checkpoint;
      const saved = await saveAt(merged, reviewRoot);
      await mirrorReviewToTicket(saved);
      return saved;
    } finally { await lock?.release(); }
  }
  async function loadReview(taskId) { return loadAt(taskId, reviewRoot); }
  async function completeReview(taskId, details = {}) { return saveReview({ ...(await loadReview(taskId) ?? { task_id: taskId }), ...details, task_id: taskId, status: "completed", completed_at: new Date().toISOString() }); }
  async function clearReview(taskId) { return clearAt(taskId, reviewRoot); }

  // Mirrors Reviewer stage progress into the single ticket checkpoint once Coder work is completed.
  async function mirrorReviewToTicket(review) {
    const ticketCheckpoint = await load(review.task_id);
    if (!ticketCheckpoint || ticketCheckpoint.status !== "completed") return;
    const prior = Array.isArray(ticketCheckpoint.stage_progress) ? ticketCheckpoint.stage_progress : [];
    const entry = { stage: "reviewer", status: review.verdict ?? review.status ?? "in_progress", review_attempt: review.review_attempt ?? 0,
      ...(review.last_completed_turn !== undefined ? { turn: review.last_completed_turn } : {}),
      ...(review.last_tool !== undefined ? { last_tool: review.last_tool } : {}), at: review.updated_at };
    const stageProgress = prior.at(-1)?.stage === "reviewer" ? [...prior.slice(0, -1), entry] : [...prior, entry];
    const updated = { ...ticketCheckpoint, review_stage: { status: review.status ?? "in_progress", verdict: review.verdict ?? null,
      review_attempt: review.review_attempt ?? 0, reviewer_id: review.reviewer_id ?? null,
      ...(review.last_completed_turn !== undefined ? { last_completed_turn: review.last_completed_turn } : {}),
      ...(review.last_tool !== undefined ? { last_tool: review.last_tool } : {}),
      last_error: review.last_error ?? null, updated_at: review.updated_at },
      stage_progress: stageProgress };
    await fileService.atomicWrite({ path: pathFor(review.task_id), content: `${JSON.stringify(updated)}\n`, replace: true });
  }

  // Lists Reviewer checkpoints that still need a verdict or a completed Coder revision.
  async function listReviewPending() {
    if (typeof fileService.listFiles !== "function") return [];
    const pending = [];
    for (const filePath of await fileService.listFiles({ glob: `${reviewRoot}/*.json` })) {
      const checkpoint = await loadReview(filePath.split("/").at(-1).slice(0, -5));
      if (checkpoint && checkpoint.verdict !== "approved" && (checkpoint.status !== "completed" || checkpoint.verdict === "request_changes")) pending.push(checkpoint);
    }
    return pending;
  }

  async function saveAt(checkpoint, baseRoot) {
    if (!checkpoint?.task_id) throw new ConfigurationError("Agent execution checkpoint requires task_id.");
    const record = { ...checkpoint, updated_at: new Date().toISOString() };
    await fileService.atomicWrite({ path: pathFor(checkpoint.task_id, baseRoot), content: `${JSON.stringify(record)}\n`, replace: true });
    await onSaved?.(record);
    return record;
  }
  async function loadAt(taskId, baseRoot) {
    try { return JSON.parse(await fileService.readFile({ path: pathFor(taskId, baseRoot) })); }
    catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  }
  async function clearAt(taskId, baseRoot) {
    await fileService.deleteFile?.({ path: pathFor(taskId, baseRoot) }).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    return true;
  }

// Builds the safe file path for a task checkpoint, rejecting unsafe characters.
  function pathFor(taskId, baseRoot = root) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(taskId)) throw new ConfigurationError("Checkpoint task_id contains unsafe characters.");
    return `${baseRoot}/${taskId}.json`;
  }
}

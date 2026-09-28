// Persists resumable agent execution checkpoints to the file service under .forge/runtime.
import { ConfigurationError } from "../../shared/errors.js";

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
        if (!["completed", "blocked"].includes(checkpoint.status)) out.push(checkpoint);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return out;
  }

  // Persists the independent Reviewer lifecycle separately from the Coder checkpoint.
  async function saveReview(checkpoint) { return saveAt(checkpoint, reviewRoot); }
  async function loadReview(taskId) { return loadAt(taskId, reviewRoot); }
  async function completeReview(taskId, details = {}) { return saveReview({ ...(await loadReview(taskId) ?? { task_id: taskId }), ...details, task_id: taskId, status: "completed", completed_at: new Date().toISOString() }); }
  async function clearReview(taskId) { return clearAt(taskId, reviewRoot); }

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

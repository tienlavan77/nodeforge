import { ConfigurationError } from "../../shared/errors.js";

export function createAgentExecutionCheckpointStore({ fileService, root = ".forge/runtime/agent-checkpoints" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Agent execution checkpoint store requires File Service persistence.");
  return Object.freeze({ save, load, complete, clear, listPending });

  async function save(checkpoint) {
    if (!checkpoint?.task_id) throw new ConfigurationError("Agent execution checkpoint requires task_id.");
    const record = { ...checkpoint, updated_at: new Date().toISOString() };
    await fileService.atomicWrite({ path: pathFor(checkpoint.task_id), content: `${JSON.stringify(record)}\n`, replace: true });
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
        if (checkpoint.status !== "completed") out.push(checkpoint);
      } catch (error) { if (error?.code !== "ENOENT") throw error; }
    }
    return out;
  }

  function pathFor(taskId) {
    if (typeof taskId !== "string" || !/^[A-Za-z0-9._:-]+$/.test(taskId)) throw new ConfigurationError("Checkpoint task_id contains unsafe characters.");
    return `${root}/${taskId}.json`;
  }
}

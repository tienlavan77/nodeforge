// Summary: Locked file store for supervisor state snapshots, separating pending and completed buckets with atomic promotion.
import { ConfigurationError } from "../../shared/errors.js";
/** Creates a locked file store for supervisor state with pending/complete separation. */
export function createSupervisorStateStore({ fileService, root = ".forge/runtime/supervisors" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function" || typeof fileService?.createLock !== "function") throw new ConfigurationError("Supervisor state store requires File Service persistence and locking.");
  return Object.freeze({ save, get, list, claimTask });
  async function save(state) {
    if (!state?.supervisor_id) throw new ConfigurationError("Supervisor state requires supervisor_id.");
    return withLock(`${root}/state.lock`, async () => {
      const id = safe(state.supervisor_id);
      const content = `${JSON.stringify(state)}\n`;
      const pendingPath = `${root}/pending/${id}.json`;
      const completePath = `${root}/complete/${id}.json`;
      if (state.state === "COMPLETED") {
        // Materialize in pending first, then rename so recovery never sees a
        // partially-written terminal snapshot and pending is removed atomically.
        await fileService.atomicWrite({ path: pendingPath, content, replace: true });
        if (typeof fileService.renameFile === "function") await fileService.renameFile({ from: pendingPath, to: completePath });
        else {
          await fileService.atomicWrite({ path: completePath, content, replace: true });
          await removeIfPresent(pendingPath);
        }
      } else {
        await fileService.atomicWrite({ path: pendingPath, content, replace: true });
        await removeIfPresent(completePath);
      }
      return state;
    });
  }
  async function get(id) { for (const bucket of ["pending", "complete"]) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${bucket}/${safe(id)}.json` })); } catch (error) { if (error?.code !== "ENOENT") throw error; } } try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(id)}.json` })); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
  async function list({ scope = "all" } = {}) {
    const buckets = scope === "pending" ? ["pending"] : scope === "complete" ? ["complete"] : ["pending", "complete"];
    const out = [];
    for (const bucket of buckets) await readPaths(`${root}/${bucket}/*.json`, out);
    const legacy = [];
    await readPaths(`${root}/*.json`, legacy);
    for (const item of legacy) {
      const isComplete = item.state === "COMPLETED";
      if ((scope === "pending" && isComplete) || (scope === "complete" && !isComplete)) continue;
      if (!out.some((current) => current.supervisor_id === item.supervisor_id)) out.push(item);
    }
    return out;
  }
  async function readPaths(glob, out) { if (typeof fileService.listFiles !== "function") return; const paths = await fileService.listFiles({ glob }); for (const path of paths) { try { out.push(JSON.parse(await fileService.readFile({ path }))); } catch (error) { if (error?.code !== "ENOENT") throw error; } } }
  async function claimTask(taskId, { supervisor_id, state = "CREATED", pending_request = {} } = {}) {
    if (typeof taskId !== "string" || !taskId.trim()) throw new ConfigurationError("Task ownership requires task_id.");
    return withLock(`${root}/ownership.lock`, async () => {
      const existing = (await list()).find((item) => item.task_id === taskId);
      if (existing) return { created: false, ...existing };
      if (typeof supervisor_id !== "string" || !supervisor_id) throw new ConfigurationError("New task ownership requires supervisor_id.");
      const record = { task_id: taskId, supervisor_id, state, pending_request, updated_at: new Date().toISOString() };
      await fileService.atomicWrite({ path: `${root}/pending/${safe(supervisor_id)}.json`, content: `${JSON.stringify(record)}\n`, replace: false });
      return { created: true, ...record };
    });
  }
  async function removeIfPresent(path) { if (typeof fileService.deleteFile !== "function") return; try { await fileService.deleteFile({ path }); } catch (error) { if (error?.code !== "ENOENT") throw error; } }
  async function withLock(path, callback) {
    for (;;) { try { const lock = await fileService.createLock({ path }); try { return await callback(); } finally { await lock.release(); } } catch (error) { if (error?.code !== "FILE_LOCK_EXISTS") throw error; await new Promise((resolve) => setTimeout(resolve, 10)); } }
  }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._:-]+$/.test(value)) throw new ConfigurationError("Supervisor ID contains unsafe characters."); return value; }

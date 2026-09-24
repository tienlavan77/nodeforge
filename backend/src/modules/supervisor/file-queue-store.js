// Summary: File-backed queue store with PID-aware lock acquisition, stale-lock recovery, and JSON persistence.
import { ConfigurationError } from "../../shared/errors.js";
export function createFileQueueStore({ fileService, root = ".forge/runtime/supervisor-queues" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("File queue store requires File Service.");
  return Object.freeze({ list, save, withLock });
  async function list(name) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(name)}.json` })); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } }
  async function withLock(name, callback, operationName = "mutation") {
    const lockPath = `${root}/lock-${safe(name)}.lock`;
    const debug = process.env.NODE_DEBUG_QUEUE_LOCKS === "1";
    const trace = (event) => { if (debug) process.stderr.write(`[queue-lock] ${event} queue=${name} op=${operationName} pid=${process.pid}\n`); };
    for (;;) {
      let lock;
      try { lock = await fileService.createLock({ path: lockPath }); trace("acquired"); }
      catch (error) {
        if (error?.code !== "FILE_LOCK_EXISTS") throw error;
        let ownerPid = null;
        // eslint-disable-next-line no-silent-catch -- Lock-owner probe: unreadable lock is treated as unknown owner below.
        try { ownerPid = Number.parseInt(await fileService.readFile({ path: lockPath }), 10); } catch {}
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          trace(`wait owner=${ownerPid}`);
          try { process.kill(ownerPid, 0); await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
          catch { trace(`remove-stale owner=${ownerPid}`); await fileService.deleteFile({ path: lockPath }).catch(() => {}); continue; } // eslint-disable-line no-silent-catch -- Stale-lock cleanup is best-effort; loop retries acquisition.
        }
        // Empty/unknown ownership may belong to a live writer; wait before stale cleanup.
        await new Promise((resolve) => setTimeout(resolve, 100));
        let retryOwner = null;
        // eslint-disable-next-line no-silent-catch -- Lock-owner re-probe before stale cleanup; unknown owner waits.
        try { retryOwner = Number.parseInt(await fileService.readFile({ path: lockPath }), 10); } catch {}
        if (!Number.isInteger(retryOwner) || retryOwner <= 0) await fileService.deleteFile({ path: lockPath }).catch(() => {}); // eslint-disable-line no-silent-catch -- Stale-lock cleanup is best-effort; loop retries acquisition.
        continue;
      }
      try { return await callback(); } finally { await lock.release().catch(() => {}); trace("released"); } // eslint-disable-line no-silent-catch -- Lock release is best-effort; callback result already decided.
    }
  }
  async function save(name, item) { const entries = await list(name); const index = entries.findIndex((entry) => entry.id === item.id); if (index < 0) entries.push(structuredClone(item)); else entries[index] = structuredClone(item); await fileService.atomicWrite({ path: `${root}/${safe(name)}.json`, content: `${JSON.stringify(entries)}\n`, replace: true }); return item; }
}
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) throw new ConfigurationError("Queue name contains unsafe characters."); return value; }

// Summary: File-backed queue store with PID-aware lock acquisition, stale-lock recovery, and JSON persistence.
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../../shared/errors.js";
const COMPLETED_RETAIN_MS = 24 * 60 * 60 * 1000;
// Drops only plain finished jobs: any entry carrying reconciliation, review, verification, completion or
// repair evidence stays, because those records are durable witnesses that recovery paths still read.
function isPrunableTerminal(entry, now) {
  if (!entry || entry.status !== "completed" || entry.reconciliation_required === true) return false;
  if (entry.review_result || entry.verification_result || entry.completion_intent || entry.repair_consumed || entry.dependency_repair) return false;
  const completedAt = Date.parse(entry.completed_at ?? "");
  if (Number.isFinite(completedAt) && now - completedAt < COMPLETED_RETAIN_MS) return false;
  return true;
}
// Defines createFileQueueStore function behavior for file-queue-store.js.
export function createFileQueueStore({ fileService, root = statePath("supervisor-queues") } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("File queue store requires File Service.");
  // A single parsed copy of each queue file is reused across repeated list() reads within one process,
  // because recovery and startup scan the same multi-megabyte queue dozens of times. save() always
  // re-reads from disk (never the cache) for its read-modify-write so a concurrent writer in another
  // process cannot be clobbered, then repopulates the cache with the bytes it just committed. Callers
  // must treat list() results as read-only; every consumer here already rebuilds entries by spreading.
  const cache = new Map();
  return Object.freeze({ list, save, pruneTerminal, withLock });
  // Defines readFresh function behavior for file-queue-store.js.
  async function readFresh(name) { try { return JSON.parse(await fileService.readFile({ path: `${root}/${safe(name)}.json` })); } catch (error) { if (error?.code === "ENOENT") return []; throw error; } }
  // Defines list function behavior for file-queue-store.js.
  async function list(name) {
    const key = safe(name);
    if (cache.has(key)) return cache.get(key);
    const entries = await readFresh(key);
    cache.set(key, entries);
    return entries;
  }
  // Defines withLock function behavior for file-queue-store.js.
  async function withLock(name, callback, operationName = "mutation") {
    const lockPath = `${root}/lock-${safe(name)}.lock`;
    const debug = process.env.NODE_DEBUG_QUEUE_LOCKS === "1";
    // Defines trace function behavior for file-queue-store.js.
    const trace = (event) => { if (debug) process.stderr.write(`[queue-lock] ${event} queue=${name} op=${operationName} pid=${process.pid}\n`); };
    for (;;) {
      let lock;
      try { lock = await fileService.createLock({ path: lockPath }); trace("acquired"); }
      catch (error) {
        if (error?.code !== "FILE_LOCK_EXISTS") throw error;
        let ownerPid = null;
        // eslint-disable-next-line no-silent-catch -- Lock-owner probe: unreadable lock is treated as unknown owner below.
        try { ownerPid = Number.parseInt(await fileService.readFile({ path: lockPath }), 10); } catch { /* Unknown lock owner remains protected. */ }
        if (Number.isInteger(ownerPid) && ownerPid > 0) {
          trace(`wait owner=${ownerPid}`);
          try { process.kill(ownerPid, 0); await new Promise((resolve) => setTimeout(resolve, 25)); continue; }
          catch { trace(`remove-stale owner=${ownerPid}`); await fileService.deleteFile({ path: lockPath }).catch(() => {}); continue; } // eslint-disable-next-line no-silent-catch -- Stale-lock cleanup is best-effort; loop retries acquisition.
        }
        // Empty/unknown ownership may belong to a live writer; wait before stale cleanup.
        await new Promise((resolve) => setTimeout(resolve, 100));
        let retryOwner = null;
        // eslint-disable-next-line no-silent-catch -- Lock-owner re-probe before stale cleanup; unknown owner waits.
        try { retryOwner = Number.parseInt(await fileService.readFile({ path: lockPath }), 10); } catch { /* Unknown lock owner remains protected. */ }
        if (!Number.isInteger(retryOwner) || retryOwner <= 0) await fileService.deleteFile({ path: lockPath }).catch(() => {}); // eslint-disable-next-line no-silent-catch -- Stale-lock cleanup is best-effort; loop retries acquisition.
        continue;
      }
      try {
        // A reader in this process may have cached a snapshot from before another writer released
        // the lock, so drop the cache entry the instant we own it: the first list() inside the
        // transaction then reloads from disk and the read-modify-write cannot clobber a cross-
        // process update. Read-only scans that never lock keep reusing the snapshot as intended.
        cache.delete(safe(name));
        return await callback();
      } finally { await lock.release().catch(() => {}); trace("released"); } // eslint-disable-next-line no-silent-catch -- Lock release is best-effort; callback result already decided.
    }
  }
  // Defines save function behavior for file-queue-store.js.
  async function save(name, item) { const key = safe(name); const entries = await readFresh(key); const index = entries.findIndex((entry) => entry.id === item.id); if (index < 0) entries.push(structuredClone(item)); else entries[index] = structuredClone(item); await fileService.atomicWrite({ path: `${root}/${key}.json`, content: `${JSON.stringify(entries)}\n`, replace: true }); cache.set(key, entries); return item; }
  // Rewrites one queue file without its finished jobs while holding the queue's cross-process lock so a
  // concurrent claim/ack cannot lose an update; a rewritten file shrinks every later list() read/parse.
  // It reads fresh from disk (not the cache) under the lock so pruning reflects on-disk truth, then
  // repopulates the cache with the pruned list so the very next list() in this process skips re-parsing.
  async function pruneTerminal(name, { now = Date.now() } = {}) {
    const key = safe(name);
    const path = `${root}/${key}.json`;
    return withLock(name, async () => {
      const entries = await readFresh(key);
      const kept = entries.filter((entry) => !isPrunableTerminal(entry, now));
      cache.set(key, kept);
      const removed = entries.length - kept.length;
      if (removed <= 0) return { removed: 0 };
      await fileService.atomicWrite({ path, content: `${JSON.stringify(kept)}\n`, replace: true });
      return { removed };
    }, "prune_terminal");
  }
}
// Defines safe function behavior for file-queue-store.js.
function safe(value) { if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/.test(value)) throw new ConfigurationError("Queue name contains unsafe characters."); return value; }

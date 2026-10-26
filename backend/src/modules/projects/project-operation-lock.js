// Crash-safe compare-and-swap lock shared by every store handle on one directory.
// Business purpose: optimistic revision control for durable lifecycle snapshots is only sound when
// the complete read-validate-replace of a mutation is serialized across processes, because two
// workers that each open their own store handle on the same managed-storage directory could
// otherwise both read revision N, both pass an expectedRevision=N check, and both replace the
// snapshot at revision N+1, silently losing the first accepted update. Technical description: the
// lock is a single wx-created file inside the store directory containing the holder pid and an ISO
// acquisition timestamp. A contending writer waits and retries with a bounded budget; once the
// acquisition timestamp is older than the stale threshold it is treated as crash residue and
// replaced. A process may hold at most one lock at a time, and all store mutations run through one
// in-memory queue, so contention between two handles never deadlocks the same process against
// itself; takeover only fires after the full stale window, by which time a live holder has
// finished. The lock path is returned so the caller unlinks exactly the file it created.
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ACQUIRE_BUDGET_MS = 5000;
const STALE_AFTER_MS = 2000;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

// Acquires the directory lock and runs `fn` while holding it, always releasing the lock afterwards.
export async function withCasLock(root, fn) {
  const path = await acquireCasLock(root);
  try {
    return await fn();
  } finally {
    await releaseCasLock(path);
  }
}

// Waits for exclusive wx-creation of the lock file; stale residue from a crashed holder is
// unlinked and raced for again, and exhaustion of the budget surfaces a retryable store_busy.
async function acquireCasLock(root) {
  const path = join(root, ".cas.lock");
  const deadline = Date.now() + ACQUIRE_BUDGET_MS;
  for (;;) {
    try {
      await writeFile(path, `${JSON.stringify({ pid: process.pid, acquired_at: new Date().toISOString() })}\n`, { flag: "wx", mode: 0o600 });
      return path;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await reclaimStaleLock(path, Date.now())) continue;
      if (Date.now() >= deadline) {
        throw Object.assign(new Error(`The operation store lock at ${path} stayed busy.`), { code: "store_busy", retryable: true });
      }
      await delay(1 + Math.floor(Math.random() * 5));
    }
  }
}

// Removes the lock only after reading proof it was acquired past the stale window; unparseable or
// partially written residue counts as stale because a live holder always writes a complete record
// before waiting writers can observe it.
async function reclaimStaleLock(path, now) {
  let record;
  try {
    record = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && error.code !== "ENOENT") throw error;
    return false;
  }
  const acquiredAt = typeof record?.acquired_at === "string" && ISO_TIME.test(record.acquired_at) ? Date.parse(record.acquired_at) : 0;
  if (!acquiredAt || now - acquiredAt <= STALE_AFTER_MS) return false;
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  return true;
}

// Deletes the lock file this process created; absence already means released.
async function releaseCasLock(path) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

// Yields the event loop between lock polls; the wait is intentionally short so contending
// transitions resolve well below the stale threshold.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

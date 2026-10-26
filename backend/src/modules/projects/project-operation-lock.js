// Crash-safe compare-and-swap lock shared by every store handle on one directory.
// Business purpose: preserve accepted lifecycle revisions across concurrent writers and restarts.
// Technical description: Lamport bakery tickets order uniquely named contenders. A contender
// publishes its choosing record before scanning tickets, then scans participants again before
// entering. Dead processes are ignored; elapsed time never revokes a live writer. Each holder
// removes only its own UUID pathname, so concurrent cleanup cannot delete a successor's lock.
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const ACQUIRE_BUDGET_MS = 5000;

// Acquires the directory lock and runs fn while holding it, always releasing its unique record.
export async function withCasLock(root, fn) {
  const path = await acquireCasLock(root);
  try {
    return await fn();
  } finally {
    await releaseCasLock(path);
  }
}

// Publishes a choosing record before assigning a bakery ticket. The second participant scan
// includes every contender that could choose an equal or lower ticket; later arrivals see ours.
async function acquireCasLock(root) {
  const directory = join(root, ".cas-locks");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, id);
  const deadline = Date.now() + ACQUIRE_BUDGET_MS;
  await writeFile(path, "0", { flag: "wx", mode: 0o600 });
  try {
    // Older implementations used one shared pathname. Never overlap a surviving old writer.
    await waitForLegacyLock(root, deadline);
    let ticket = 1;
    for (const other of await readdir(directory)) {
      const value = await readTicket(directory, other);
      if (value !== null) ticket = Math.max(ticket, value + 1);
    }
    await writeFile(`${path}.tmp`, String(ticket), { flag: "wx", mode: 0o600 });
    await rename(`${path}.tmp`, path);
    for (const other of await readdir(directory)) {
      if (other === id || !other.endsWith(".json")) continue;
      for (;;) {
        const value = await readTicket(directory, other);
        if (value === null || (value > 0 && (value > ticket || (value === ticket && other > id)))) break;
        await waitForContender(deadline);
      }
    }
    return path;
  } catch (error) {
    await releaseCasLock(path);
    throw error;
  }
}

// Reads a participant only while its process may still execute. UUID paths are never reused,
// making dead-record removal safe even when several contenders observe the same crashed owner.
async function readTicket(directory, id) {
  if (!/^\d+-[a-f0-9-]+\.json$/.test(id)) return null;
  const path = join(directory, id);
  if (!isProcessAlive(Number(id.split("-")[0]))) {
    await releaseCasLock(path);
    return null;
  }
  try {
    const raw = await readFile(path, "utf8");
    const value = Number(raw);
    return raw.trim() && Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Uses only definite process death as recovery evidence. PID reuse and permission failures
// conservatively retain ownership rather than admitting overlapping snapshot writers.
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
}

// Preserves exclusivity during upgrade from the previous shared-file protocol; unknown or
// malformed legacy owners fail closed and require operator inspection rather than unsafe reuse.
async function waitForLegacyLock(root, deadline) {
  for (;;) {
    let record;
    try {
      record = JSON.parse(await readFile(join(root, ".cas.lock"), "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return;
      if (!(error instanceof SyntaxError)) throw error;
    }
    if (Number.isSafeInteger(record?.pid) && record.pid > 0 && !isProcessAlive(record.pid)) return;
    await waitForContender(deadline);
  }
}

// Deletes only a uniquely owned participant pathname; no holder ever releases a shared path.
async function releaseCasLock(path) {
  await unlink(path).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
}

// Bounds acquisition waiting without treating timeout as permission to revoke another writer.
async function waitForContender(deadline) {
  if (Date.now() >= deadline) {
    throw Object.assign(new Error("The operation store lock stayed busy."), { code: "store_busy", retryable: true });
  }
  await delay(5);
}

// Yields between participant probes so other handles can publish and release their tickets.
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

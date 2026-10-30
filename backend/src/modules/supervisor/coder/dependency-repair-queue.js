// Keeps dependency intent receipts immutable and dispatch reservations exclusive across API processes.
// Ordinary ticket launch claims remain authoritative for unknown provider outcomes after a restart.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dependencyRepairError } from "./dependency-repair-contract.js";

// Names the durable coordination queue independently of provider execution queues.
export const DEPENDENCY_REPAIR_QUEUE = "ticket.dependency-repair";

// Recovers a receipt written before a queue-save crash without replacing its original request bytes.
export async function persistDependencyRequest(fileService, record) {
  let existing;
  try { existing = JSON.parse(await fileService.readFile({ path: record.receipt })); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!existing) {
    try { await fileService.atomicWrite({ path: record.receipt, content: JSON.stringify(record), replace: false }); return record; }
    catch (error) {
      if (!["FILE_ALREADY_EXISTS", "EEXIST"].includes(error.code)) throw error;
      existing = JSON.parse(await fileService.readFile({ path: record.receipt }));
    }
  }
  if (existing.id !== record.id || !isDeepStrictEqual(existing.parent, record.parent)
    || !isDeepStrictEqual(existing.request, record.request) || !isDeepStrictEqual(existing.target, record.target))
    throw dependencyRepairError("Immutable dependency request conflicts with the recorded execution.");
  return existing;
}

// Distinguishes a live dispatch reservation from an API process proven to have exited.
export function dependencyRepairOwnerAlive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

// Reserves both the request and target under one lock, never holding it during a provider invocation.
export async function reserveDependencyRepair(store, entry, clock) {
  return store.withLock(DEPENDENCY_REPAIR_QUEUE, async () => {
    const entries = await store.list(DEPENDENCY_REPAIR_QUEUE);
    const current = entries.find((item) => item.id === entry.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status) || dependencyRepairOwnerAlive(current.owner)) return null;
    if (entries.some((item) => item.id !== current.id && item.target.ticket.id === current.target.ticket.id
      && ["dispatching", "running"].includes(item.status))) return null;
    const reserved = { ...current, status: "dispatching", owner: { pid: process.pid, token: randomUUID() }, updated_at: clock() };
    await store.save(DEPENDENCY_REPAIR_QUEUE, reserved);
    return reserved;
  });
}

// Ignores stale SDK completions and process callbacks after cancellation or replacement of their reservation.
export async function saveDependencyRepair(store, entry, patch, clock) {
  return store.withLock(DEPENDENCY_REPAIR_QUEUE, async () => {
    const current = (await store.list(DEPENDENCY_REPAIR_QUEUE)).find((item) => item.id === entry.id);
    if (!current || ["completed", "failed", "cancelled"].includes(current.status)
      || entry.owner && current.owner?.token !== entry.owner.token) return null;
    const saved = { ...current, ...patch, updated_at: clock() };
    await store.save(DEPENDENCY_REPAIR_QUEUE, saved);
    return saved;
  });
}

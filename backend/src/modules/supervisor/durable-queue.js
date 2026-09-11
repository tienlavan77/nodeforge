import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

export function createDurableQueue({ name, store, clock = () => Date.now(), leaseMs = 60000, maxAttempts = 3 } = {}) {
  if (!name || typeof store?.list !== "function" || typeof store?.save !== "function") throw new ConfigurationError("Durable queue requires name, list and save store methods.");
  return Object.freeze({ enqueue, claim, ack, reject, recover });

  async function transact(operation, operationName = "mutation") {
    if (typeof store.withLock !== "function") return operation();
    // null is a valid empty-queue result from claim(); never spin on it.
    return store.withLock(name, operation, operationName);
  }
  async function enqueue(command) { return transact(async () => {
    if (typeof command?.request_id !== "string" || !command.request_id) throw new ConfigurationError("Queue command requires request_id.");
    const existing = (await store.list(name)).find((item) => item.request_id === command.request_id);
    if (existing) return existing;
    const item = { queue: name, id: `JOB-${randomUUID()}`, ...structuredClone(command), status: "queued", attempts: 0, created_at: new Date(clock()).toISOString() };
    await store.save(name, item); return item;
  }, "enqueue"); }
  async function claim(workerId) { return transact(async () => {
    const now = clock(); const items = await store.list(name);
    const item = items.find((entry) => entry.status === "queued" || (entry.status === "leased" && Date.parse(entry.lease_until) <= now));
    if (!item) return null;
    const claimed = { ...item, status: "leased", worker_id: workerId, attempts: item.attempts + 1, lease_until: new Date(now + leaseMs).toISOString() };
    await store.save(name, claimed); return claimed;
  }, "claim"); }
  async function ack(id) { return update(id, { status: "completed", completed_at: new Date(clock()).toISOString() }); }
  async function reject(id, reason) { return transact(async () => {
    const item = (await store.list(name)).find((entry) => entry.id === id); if (!item) return null;
    const changes = item.attempts >= maxAttempts ? { status: "dead_letter", failure_reason: reason } : { status: "queued", failure_reason: reason };
    const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); return next;
  }); }
  async function recover() { return transact(async () => {
    const now = clock(); const items = await store.list(name); const recovered = [];
    for (const item of items) if (item.status === "leased" && Date.parse(item.lease_until) <= now) {
      const changes = item.attempts >= maxAttempts ? { status: "dead_letter", failure_reason: "lease_expired" } : { status: "queued", failure_reason: "lease_expired" };
      const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); recovered.push(next);
    }
    return recovered;
  }, "recover"); }
  async function update(id, changes) { return transact(async () => {
    const item = (await store.list(name)).find((entry) => entry.id === id); if (!item) return null;
    const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); return next;
  }); }
}

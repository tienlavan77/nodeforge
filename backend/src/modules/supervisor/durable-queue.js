import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

export function createDurableQueue({ name, store, clock = () => Date.now(), leaseMs = 60000, maxAttempts = 3 } = {}) {
  if (!name || typeof store?.list !== "function" || typeof store?.save !== "function") throw new ConfigurationError("Durable queue requires name, list and save store methods.");
  return Object.freeze({ enqueue, claim, ack, reject, recover });

  async function enqueue(command) {
    if (typeof command?.request_id !== "string" || !command.request_id) throw new ConfigurationError("Queue command requires request_id.");
    const existing = (await store.list(name)).find((item) => item.request_id === command.request_id);
    if (existing) return existing;
    const item = { queue: name, id: `JOB-${randomUUID()}`, ...structuredClone(command), status: "queued", attempts: 0, created_at: new Date(clock()).toISOString() };
    await store.save(name, item); return item;
  }
  async function claim(workerId) {
    const now = clock();
    const items = await store.list(name);
    const item = items.find((entry) => entry.status === "queued" || (entry.status === "leased" && Date.parse(entry.lease_until) <= now));
    if (!item) return null;
    const claimed = { ...item, status: "leased", worker_id: workerId, attempts: item.attempts + 1, lease_until: new Date(now + leaseMs).toISOString() };
    await store.save(name, claimed); return claimed;
  }
  async function ack(id) { return update(id, { status: "completed", completed_at: new Date(clock()).toISOString() }); }
  async function reject(id, reason) {
    const item = (await store.list(name)).find((entry) => entry.id === id);
    if (!item) return null;
    return update(id, item.attempts >= maxAttempts ? { status: "dead_letter", failure_reason: reason } : { status: "queued", failure_reason: reason });
  }
  async function recover() {
    const now = clock();
    const items = await store.list(name);
    return Promise.all(items.filter((item) => item.status === "leased" && Date.parse(item.lease_until) <= now).map((item) => reject(item.id, "lease_expired")));
  }
  async function update(id, changes) {
    const item = (await store.list(name)).find((entry) => entry.id === id);
    if (!item) return null;
    const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() };
    await store.save(name, next); return next;
  }
}

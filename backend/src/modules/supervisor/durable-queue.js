// Summary: Durable leased queue with enqueue/claim/ack/reject/recover semantics backed by a pluggable store and optional file lock.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";

export function createDurableQueue({ name, store, clock = () => Date.now(), leaseMs = 60000, maxAttempts = 3 } = {}) {
  if (!name || typeof store?.list !== "function" || typeof store?.save !== "function") throw new ConfigurationError("Durable queue requires name, list and save store methods.");
  return Object.freeze({ enqueue, claim, ack, reject, quarantine, recover });

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
    let item;
    for (const entry of items) {
      if (entry.status !== "queued" && !(entry.status === "leased" && Date.parse(entry.lease_until) <= now)) continue;
      const reconciliation = inlineReconciliation(entry);
      if (reconciliation) { await store.save(name, { ...entry, ...reconciliation, updated_at: new Date(now).toISOString() }); continue; }
      item = entry; break;
    }
    if (!item) return null;
    const claimed = { ...item, status: "leased", worker_id: workerId, attempts: item.attempts + 1, lease_until: new Date(now + leaseMs).toISOString() };
    await store.save(name, claimed); return claimed;
  }, "claim"); }
  async function ack(id) { return update(id, { status: "completed", completed_at: new Date(clock()).toISOString() }); }
  async function reject(id, reason) { return transact(async () => {
    const item = (await store.list(name)).find((entry) => entry.id === id); if (!item) return null;
    const changes = inlineReconciliation(item) ?? (item.attempts >= maxAttempts ? { status: "dead_letter", failure_reason: reason } : { status: "queued", failure_reason: reason });
    const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); return next;
  }); }
  // Retains an invalidated handoff as reconciliation evidence while preventing automatic queue retry.
  async function quarantine(id, { requestId, reason } = {}) { return transact(async () => {
    const item = (await store.list(name)).find((entry) => entry.id === id);
    if (!item) throw new ConfigurationError("Reconciliation handoff is missing.");
    if (!requestId || item.request_id !== requestId) throw new ConfigurationError("Reconciliation handoff request identity changed.");
    if (item.status === "completed") return item;
    const next = { ...item, status: "dead_letter", failure_reason: reason ?? "execution_reconciliation_required", reconciliation_required: true, updated_at: new Date(clock()).toISOString() };
    await store.save(name, next); return next;
  }, "quarantine"); }
  async function recover() { return transact(async () => {
    const now = clock(); const items = await store.list(name); const recovered = [];
    for (const item of items) if (item.status === "queued" && inlineReconciliation(item) || item.status === "leased" && Date.parse(item.lease_until) <= now) {
      const changes = inlineReconciliation(item) ?? (item.attempts >= maxAttempts ? { status: "dead_letter", failure_reason: "lease_expired" } : { status: "queued", failure_reason: "lease_expired" });
      const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); recovered.push(next);
    }
    return recovered;
  }, "recover"); }
  // Keeps captured Registry handoffs under their inline owner after crash or response loss; queue recovery never grants redispatch.
  function inlineReconciliation(item) {
    return name === "sender.handoff" && item.payload && Object.hasOwn(item.payload, "dependency_expectations")
      ? { status: "dead_letter", failure_reason: "inline_execution_reconciliation_required", reconciliation_required: true }
      : null;
  }
  async function update(id, changes) { return transact(async () => {
    const item = (await store.list(name)).find((entry) => entry.id === id); if (!item) return null;
    const next = { ...item, ...changes, updated_at: new Date(clock()).toISOString() }; await store.save(name, next); return next;
  }); }
}

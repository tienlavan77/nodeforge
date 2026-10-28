// Provides module declarations and business logic for worker-status-bus.js.

import { EventEmitter } from "node:events";
// Defines createWorkerStatusBus, publish, subscribe, get function/method behavior for worker-status-bus.js.
export function createWorkerStatusBus({ heartbeatMs = 15000 } = {}) { const bus = new EventEmitter(); const snapshots = new Map(); return Object.freeze({ publish(status) { const next = { ...status, timestamp: new Date().toISOString() }; snapshots.set(status.worker_id, next); bus.emit("status", next); }, subscribe(handler) { bus.on("status", handler); return () => bus.off("status", handler); }, get(workerId) { return snapshots.get(workerId) ?? null; }, heartbeatMs }); }

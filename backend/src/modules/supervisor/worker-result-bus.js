// Provides module declarations and business logic for worker-result-bus.js.

import { EventEmitter } from "node:events";
// Defines createWorkerResultBus, publish, subscribe function/method behavior for worker-result-bus.js.
export function createWorkerResultBus() { const bus = new EventEmitter(); return Object.freeze({ publish(result) { bus.emit("result", result); }, subscribe(handler) { bus.on("result", handler); return () => bus.off("result", handler); } }); }

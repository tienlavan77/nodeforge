import { EventEmitter } from "node:events";
export function createWorkerResultBus() { const bus = new EventEmitter(); return Object.freeze({ publish(result) { bus.emit("result", result); }, subscribe(handler) { bus.on("result", handler); return () => bus.off("result", handler); } }); }

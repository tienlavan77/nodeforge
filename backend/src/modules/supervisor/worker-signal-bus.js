// Summary: EventEmitter-based signal bus for waking workers by queue name with publish counting and debug logging.
import { EventEmitter } from "node:events";
// Defines createWorkerSignalBus function behavior for worker-signal-bus.js.
export function createWorkerSignalBus({ debug = process.env.NODE_DEBUG_WORKER_SIGNALS ? console : null } = {}) {
  const bus = new EventEmitter();
  const counts = new Map();
  return Object.freeze({ wakeup, onWakeup, getCounts: () => Object.fromEntries(counts) });
  // Defines wakeup function behavior for worker-signal-bus.js.
  function wakeup(message = {}) {
    const source = message.source ?? "unknown";
    counts.set(source, (counts.get(source) ?? 0) + 1);
    debug?.debug?.(`[worker-signal] ${source} -> ${message.queue ?? message.target ?? "unknown"} #${counts.get(source)}`);
    bus.emit("wakeup", message);
  }
  // Defines onWakeup function behavior for worker-signal-bus.js.
  function onWakeup(handler) { bus.on("wakeup", handler); return () => bus.off("wakeup", handler); }
}

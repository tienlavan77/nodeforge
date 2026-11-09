// Provides shared application event-bus bridging and pre-activation SSE stream handles for project runtimes.
// Business purpose: keeps in-process, Worker Thread, and background-admitted project runtimes seamless when streaming live progress and cleaning up SSE connections.
// Technical description: exports `createApplicationBridge` for bidirectional `internalBus`/`subscriptions` forwarding and `createPendingProjectRuntime` for immediate SSE streaming before background runtime activation completes.
import { EventEmitter } from "node:events";
import { createSubscriptionRegistry } from "../events/subscription-registry.js";
import { createProjectStream } from "../../transport/sse/project-stream.js";

// Creates a pre-activation runtime handle that serves SSE streams and running status immediately upon catalog admission.
// Business purpose: allows `POST /forge/v1/projects` to return immediately after fast preflight/catalog commit while `GET /forge/v1/stream?project=<id>` connects without waiting for database or Worker Thread initialization.
// Technical description: initializes a shared `bus`, `subscriptions`, and `connections` set with a `createProjectStream` instance that the activated runtime adopts seamlessly.
export function createPendingProjectRuntime({ projectRoot, projectId, progress, logger = console }) {
  const bus = new EventEmitter();
  const subscriptions = createSubscriptionRegistry({ logger });
  const connections = new Set();
  let closed = false;
  const stream = createProjectStream({
    projectId,
    indexDb: { all: () => [] },
    runtimeSnapshot: () => {
      const snap = progress.snapshot();
      return {
        readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running",
        stage: snap.stage,
        status: snap.status,
        progress: snap
      };
    },
    subscriptions,
    eventBus: bus
  });
  // Connects an SSE subscriber to the pending project stream and tracks the connection for lifecycle disposal.
  // Business purpose: enables real-time progress streaming from the very first millisecond after project admission.
  // Technical description: delegates to `stream.connect(input)` and registers a disconnect callback in `connections`.
  function connect(input) {
    if (closed) throw new Error("Project runtime is closed.");
    const connection = stream.connect(input);
    const response = input.response;
    // Removes the SSE connection from tracking when the client disconnects or the runtime closes.
    // Business purpose: prevents memory leaks and dangling HTTP responses.
    // Technical description: deletes `owned` from `connections` and closes the underlying stream connection.
    function disconnect() {
      connections.delete(owned);
      response.off?.("close", disconnect);
      connection.close();
    }
    const owned = { close: disconnect };
    connections.add(owned);
    response.once?.("close", disconnect);
    return owned;
  }
  // Reports the current pre-activation progress and readiness state.
  // Business purpose: surfaces `readiness: "running"` and initial stage progress to `/forge/v1/projects` callers.
  // Technical description: reads `progress.snapshot()` and computes readiness.
  function status() {
    const snap = progress.snapshot();
    return {
      projectId,
      projectRoot,
      embeddingError: snap.embedding?.error ?? null,
      closed,
      readiness: closed || snap.status === "failed" ? "unavailable" : snap.status === "succeeded" ? "ready" : "running",
      progress: snap
    };
  }
  // Closes all active SSE connections opened during the pre-activation window.
  // Business purpose: ensures clean teardown if the project is removed before background activation finishes.
  // Technical description: marks `closed = true` and closes every tracked connection.
  async function close() {
    closed = true;
    for (const connection of [...connections]) {
      try { connection.close(); } catch (error) { logger.error?.("Pending stream close failed.", { error }); }
    }
    bus.removeAllListeners();
  }
  return Object.freeze({ projectRoot, projectId, bus, subscriptions, connections, connect, status, close });
}

// Bridges a project's runtime SSE stream and internal event bus with its composed Control API application services.
// Business purpose: ensures project-scoped SSE subscribers and application services exchange live events (`watcher.indexed`, `agent.activity`, conversation streams) without leaking across projects.
// Technical description: attaches bidirectional listeners between `services.internalBus`, `services.subscriptions`, and the runtime `bus`/`subscriptions`, returning an unbind cleanup function.
export function createApplicationBridge({ projectId, bus, subscriptions, conversationListeners, isClosed }) {
  let boundServices = null;
  let unbindServices = null;
  // Binds one project application service bundle to the runtime event bus and subscription registry.
  // Business purpose: connects conversation and agent execution streams to the active project runtime once the workspace is resolved.
  // Technical description: subscribes conversation listeners, forwards matching `projectId` events, invalidates `codeCache` on `watcher.indexed`, and returns a detach callback.
  function bindApplication(services) {
    if (!services || isClosed()) return () => {};
    if (services.projectId && services.projectId !== projectId) {
      throw new Error("Project runtime and application identity differ.");
    }
    unbindServices?.();
    boundServices = services;
    for (const listener of conversationListeners) services.bus?.subscribeAll?.(listener);
    let forwarding = false;
    // Relays application subscription events belonging to this project into the runtime SSE subscription registry.
    // Business purpose: delivers application-level notifications over the unified project SSE stream.
    // Technical description: guards against re-entrant loops and publishes matching `projectId` events to `subscriptions`.
    const onAppSubscription = (event) => {
      if (forwarding || isClosed() || (event?.project_id ?? event?.metadata?.project_id) !== projectId) return;
      forwarding = true;
      try { subscriptions.publish(event); } finally { forwarding = false; }
    };
    const appSubId = services.subscriptions?.subscribe ? services.subscriptions.subscribe("*", onAppSubscription) : null;
    const bridgedEvents = ["watcher.indexed", "agent.text_stream", "agent.message.delta", "agent.message.received", "agent.status_changed", "agent.checkpoint.updated", "agent.activity"];
    const appBusListeners = [];
    const runtimeBusListeners = [];
    if (services.internalBus && services.internalBus !== bus) {
      for (const eventType of bridgedEvents) {
        // Relays internal application events for this project onto the runtime event bus.
        // Business purpose: allows project stream subscribers to observe agent and conversation updates emitted by application services.
        // Technical description: forwards matching `projectId` events from `services.internalBus` to `bus`.
        const fromApp = (event) => {
          if (forwarding || isClosed() || (event?.project_id ?? event?.metadata?.project_id) !== projectId) return;
          forwarding = true;
          try { bus.emit(eventType, event); } finally { forwarding = false; }
        };
        // Relays runtime watcher and indexing progress events onto the application internal bus.
        // Business purpose: invalidates the application code cache and notifies services when the background worker indexes a file.
        // Technical description: invalidates `services.codeCache` on `watcher.indexed` and emits the event on `services.internalBus`.
        const fromRuntime = (event) => {
          if (forwarding || isClosed() || (event?.project_id ?? event?.metadata?.project_id) !== projectId) return;
          if (eventType === "watcher.indexed" && typeof event?.payload?.path === "string" && event.payload.path) {
            services.codeCache?.invalidate?.({ path: event.payload.path });
          }
          forwarding = true;
          try { services.internalBus.emit(eventType, event); } finally { forwarding = false; }
        };
        services.internalBus.on?.(eventType, fromApp);
        bus.on(eventType, fromRuntime);
        appBusListeners.push({ eventType, fn: fromApp });
        runtimeBusListeners.push({ eventType, fn: fromRuntime });
      }
    }
    // Detaches all bridged application listeners when the application bundle or runtime closes.
    // Business purpose: prevents memory leaks and stale cross-project event delivery after project removal.
    // Technical description: unsubscribes all registered listeners from `services` and `bus`.
    const detach = () => {
      if (boundServices !== services) return;
      for (const listener of conversationListeners) services.bus?.unsubscribeAll?.(listener);
      if (appSubId !== null) services.subscriptions?.unsubscribe?.(appSubId);
      for (const { eventType, fn } of appBusListeners) services.internalBus?.off?.(eventType, fn);
      for (const { eventType, fn } of runtimeBusListeners) bus.off(eventType, fn);
      boundServices = null;
      unbindServices = null;
    };
    unbindServices = detach;
    return detach;
  }
  return {
    bindApplication,
    getBoundServices: () => boundServices,
    unbind: () => unbindServices?.()
  };
}

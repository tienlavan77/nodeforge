import { ConfigurationError } from "../../shared/errors.js";
export function createSupervisorLoop({ runtime, senderQueue, materializerQueue, verificationQueue, repairQueue, eventBus, maxAttempts = 3, roundController } = {}) {
  if (!runtime || typeof eventBus?.publish !== "function") throw new ConfigurationError("Supervisor loop requires runtime and event bus.");
  return Object.freeze({ start, onEvent });
  async function start(request) {
    const initial = typeof roundController?.start === "function" ? await roundController.start(request) : request;
    await runtime.transition("REQUESTING", initial);
    await senderQueue.enqueue(initial);
    return runtime.transition("WAITING_AGENT", initial);
  }
  async function onEvent(event) {
    if (event.supervisor_id !== runtime.supervisorId) return false;
    if (event.type === "agent.response.received") {
      const response = event.payload?.response?.payload ?? event.payload?.response ?? event.payload;
      if (typeof roundController?.onResponse === "function") {
        const next = await roundController.onResponse({ event, response, runtime });
        if (next?.request) { await runtime.transition("REQUESTING", next.request); await senderQueue.enqueue(next.request); await runtime.transition("WAITING_AGENT", next.request); return true; }
        if (next?.materialize === false) return true;
      }
      await runtime.transition("MATERIALIZING", event);
      await materializerQueue.enqueue({ ...event, ...response, task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt }); return true;
    }
    if (event.type === "materialization.completed") { await runtime.transition("VERIFYING", event); await verificationQueue.enqueue(event.payload); return true; }
    if (event.type === "materialization.invalid") { await runtime.transition("REPAIRING", event); if ((event.attempt ?? 1) >= maxAttempts) { await runtime.transition("NEEDS_HUMAN_REVIEW", event); return true; } await repairQueue.enqueue(event.payload); return true; }
    if (event.type === "verification.passed") { await runtime.transition("COMPLETED", event); await terminal("task.completed", event); return true; }
    if (event.type === "verification.failed") { await runtime.transition("REPAIRING", event); await repairQueue.enqueue(event.payload); return true; }
    if (event.type === "repair.completed") { await runtime.transition("MATERIALIZING", event); await materializerQueue.enqueue(event.payload); return true; }
    if (event.type === "agent.response.failed") { await runtime.transition("FAILED", event); await terminal("task.failed", event); return true; }
    return false;
  }
  async function terminal(type, event) { await eventBus.publish({ type, task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, payload: { status: type === "task.completed" ? "completed" : "failed" } }); }
}

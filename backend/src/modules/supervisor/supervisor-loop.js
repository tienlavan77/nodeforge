// Summary: Supervisor state machine that dispatches agent requests and routes agent/collector/verification events to transitions.
import { ConfigurationError } from "../../shared/errors.js";
/** Creates the supervisor loop that starts tasks and routes execution events to runtime transitions. */
export function createSupervisorLoop({ runtime, senderQueue, collectorQueue, verificationQueue, eventBus, attemptBuilder, requestStore, agentResolver } = {}) {
  if (!runtime || typeof eventBus?.publish !== "function") throw new ConfigurationError("Supervisor loop requires runtime and event bus.");
  let started = false;
  return Object.freeze({ start, reset, onEvent });
  async function reset() { started = false; }
  async function start(request, { resume = false } = {}) {
    if (started && !resume) return request;
    if (!resume && request?.request_id && requestStore?.claim && !(await requestStore.claim(request.request_id, "start"))) return request;
    started = true;
    const selected = selectAgent(request);
    await runtime.transition("RUNNING", selected);
    await senderQueue.enqueue(selected);
    return selected;
  }
  function selectAgent(request, { fallback = request } = {}) {
    if (request?.agent_id) return request;
    if (typeof agentResolver?.resolveAvailable !== "function") return request;
    const requiredRole = request?.required_role ?? request?.ticket?.required_role ?? request?.payload?.required_role ?? request?.payload?.ticket?.required_role ?? fallback?.required_role ?? fallback?.ticket?.required_role;
    const profile = agentResolver.resolveAvailable(requiredRole);
    if (!profile) throw Object.assign(new ConfigurationError(requiredRole ? `No ready enabled Agent Profile found for role: ${requiredRole}.` : "No ready enabled Agent Profile is available."), { code: "AGENT_NOT_AVAILABLE", required_role: requiredRole });
    return { ...request, agent_id: profile.agent_id, selected_agent_id: profile.agent_id, selected_agent_role: profile.role };
  }
  async function onEvent(event) {
    if (event.supervisor_id !== runtime.supervisorId) return false;
    if (event.request_id && requestStore?.claim && !(await requestStore.claim(event.request_id, event.type))) return true;
    if (event.type === "agent.response.received") {
      const candidate = event.payload?.response ?? event.payload;
      const nested = candidate?.payload;
      const tool = candidate?.tool_use ?? nested?.tool_use;
      const response = candidate?.type ? candidate : nested?.type ? nested : tool?.name && tool.input && typeof tool.input === "object" ? { ...tool.input, type: tool.name, payload: tool.input, response_id: candidate?.response_id ?? nested?.response_id } : candidate;
      if (typeof attemptBuilder?.onResponse === "function") {
        await attemptBuilder.onResponse({ event, response, runtime });
      }
      await runtime.transition("VERIFYING", event);
      await collectorQueue.enqueue({ ...event, ...(response?.payload && typeof response.payload === "object" ? response.payload : {}), task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt });
      return true;
    }
    if (event.type === "changeset.collected") {
      const payload = event.payload ?? {};
      const changed = payload.changed_paths ?? {};
      const empty = payload.empty ?? Object.keys(changed).length === 0;
      if (empty) {
        await runtime.transition("REPAIRING", event);
        const request = await startRepairRound(event, "empty_changeset");
        return { handled: true, request };
      }
      const queuedJob = await verificationQueue.enqueue({ ...event, ...(payload ?? {}), changed_paths: changed, checksums: payload.checksums ?? {}, empty: false, task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1 });
      return { handled: true, changed_paths: changed, job: queuedJob };
    }
    if (event.type === "verification.passed") { await runtime.transition("COMPLETED", event); await terminal("task.completed", event); return true; }
    if (event.type === "verification.failed") { await runtime.transition("REPAIRING", event); const request = await startRepairRound(event, "verification"); return { handled: true, request }; }
    if (event.type === "agent.response.failed") { await runtime.transition("FAILED", event); await terminal("task.failed", event); return true; }
    return false;
  }
  // Repair is a first-class supervised attempt: the attempt builder builds and
  // persists attempt N (N > 1) into Protocol Storage, then the request is queued
  // for the Session Runner. Nothing here sends or persists directly.
  async function startRepairRound(event, reason) {
    if (typeof attemptBuilder?.requestRepair !== "function") throw new ConfigurationError("Supervisor attempt builder does not support repair attempts.");
    const request = await attemptBuilder.requestRepair({ ...event, reason });
    await senderQueue.enqueue(request);
    await runtime.transition("RUNNING", request);
    return request;
  }
  async function terminal(type, event, payload = {}) { await eventBus.publish({ type, task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, payload }); }
}

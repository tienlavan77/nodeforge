import { ConfigurationError } from "../../shared/errors.js";
export function createSupervisorLoop({ runtime, senderQueue, materializerQueue, verificationQueue, eventBus, roundController, requestStore, agentResolver } = {}) {
  if (!runtime || typeof eventBus?.publish !== "function") throw new ConfigurationError("Supervisor loop requires runtime and event bus.");
  let started = false;
  return Object.freeze({ start, reset, onEvent });
  async function reset() { started = false; }
  async function start(request, { resume = false } = {}) {
    if (started && !resume) return request;
    if (!resume && request?.request_id && requestStore?.claim && !(await requestStore.claim(request.request_id, "start"))) return request;
    started = true;
    const initial = resume || request?.payload?.step_id > 1 ? request : (typeof roundController?.start === "function" ? await roundController.start(request) : request);
    const selected = selectAgent(initial, { fallback: request });
    await runtime.transition("REQUESTING", selected);
    await senderQueue.enqueue(selected);
    return runtime.transition("WAITING_AGENT", selected);
  }
  function selectAgent(request, { fallback } = {}) {
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
      let next;
      if (typeof roundController?.onResponse === "function") {
        next = await roundController.onResponse({ event, response, runtime });
        if (next?.request) { const selected = selectAgent(next.request, { fallback: initial }); await runtime.transition("REQUESTING", selected); await senderQueue.enqueue(selected); await runtime.transition("WAITING_AGENT", selected); return true; }
        if (next?.materialize === false) return true;
      }
      await materializerQueue.enqueue({ ...event, ...response, ...(response?.payload && typeof response.payload === "object" ? response.payload : {}), approved_plan: next?.approved_plan ?? event.approved_plan, task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt });
      return true;
    }
    if (event.type === "material_verification.completed" || event.type === "material_verification.invalid") {
      const payload = event.payload ?? {};
      const valid = payload.valid ?? {};
      const invalid = payload.invalid ?? {};
      const hasInvalid = Object.keys(invalid).length > 0;
      const hasValid = Object.keys(valid).length > 0;
      const supervisorDecision = hasInvalid ? "repair" : (hasValid ? "verification" : "failed");
      if (supervisorDecision === "failed") { await runtime.transition("FAILED", event); await terminal("task.failed", event); return true; }
      await runtime.transition(supervisorDecision === "repair" ? "REPAIRING" : "VERIFYING", event);
      if (supervisorDecision === "repair") { const request = await startRepairRound(event, "materialization"); return { handled: true, valid, invalid, supervisor_decision: supervisorDecision, request }; }
      const queuedJob = await verificationQueue.enqueue({ ...event, ...(payload ?? {}), valid, invalid, task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1 });
      return { handled: true, valid, invalid, supervisor_decision: supervisorDecision, job: queuedJob };
    }
    if (event.type === "verification.passed") { await runtime.transition("COMPLETED", event); await terminal("task.completed", event); return true; }
    if (event.type === "verification.failed") { await runtime.transition("REPAIRING", event); const request = await startRepairRound(event, "verification"); return { handled: true, request }; }
    if (event.type === "repair.completed") { await runtime.transition("MATERIALIZING", event); await materializerQueue.enqueue({ ...event, ...(event.payload ?? {}), task_id: event.task_id, supervisor_id: event.supervisor_id, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1 }); return true; }
    if (event.type === "agent.response.failed") { await runtime.transition("FAILED", event); await terminal("task.failed", event); return true; }
    return false;
  }
  // Repair is a first-class supervised round: the round controller builds and
  // persists round N (N > 3) into Protocol Storage, then the request is queued
  // for the Sender Worker. Nothing here sends or persists directly.
  async function startRepairRound(event, reason) {
    if (typeof roundController?.requestRepair !== "function") throw new ConfigurationError("Supervisor round controller does not support repair rounds.");
    const request = await roundController.requestRepair({ ...event, payload: { ...event.payload, invalid_patches: event.payload?.invalid_patches ?? Object.values(event.payload?.invalid ?? {}) }, reason });
    await runtime.transition("REQUESTING", request);
    await senderQueue.enqueue(request);
    await runtime.transition("WAITING_AGENT", request);
    return request;
  }
  async function terminal(type, event, payload = {}) { await eventBus.publish({ type, task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, payload }); }
}

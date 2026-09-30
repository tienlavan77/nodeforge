// Summary: Supervisor state machine that dispatches agent requests and routes agent/collector/verification events to transitions.
import { ConfigurationError } from "../../shared/errors.js";
/** Creates the supervisor loop that starts tasks and routes execution events to runtime transitions. */
export function createSupervisorLoop({ runtime, senderQueue, collectorQueue, verificationQueue, sourceRequest, eventBus, attemptBuilder, requestStore, agentResolver, agentOccupancy, integrateTicket } = {}) {
  if (!runtime || typeof eventBus?.publish !== "function") throw new ConfigurationError("Supervisor loop requires runtime and event bus.");
  let started = false;
  return Object.freeze({ start, reset, onEvent });
  async function reset() { started = false; }
  async function start(request, { resume = false } = {}) {
    if (started && !resume) return request;
    agentResolver?.refresh?.();
    const selected = await claimCoder(selectAgent(request));
    if (!resume && request?.request_id && requestStore?.claim && !(await requestStore.claim(request.request_id, "start"))) {
      if (selected.claim_created) await agentOccupancy.release({ claimId: selected.claim_id, taskId: runtime.taskId, supervisorId: runtime.supervisorId, reason: "duplicate_start" });
      return selected;
    }
    await runtime.transition("RUNNING", selected);
    await senderQueue.enqueue(selected);
    started = true;
    return selected;
  }
  function selectAgent(request, { fallback = request } = {}) {
    if (request?.agent_id) return request;
    const claimed = agentOccupancy?.getByTask(runtime.taskId);
    if (claimed) return { ...request, agent_id: claimed.agent_id, selected_agent_id: claimed.agent_id, selected_agent_role: "coder", claim_id: claimed.claim_id };
    if (typeof agentResolver?.resolveAvailable !== "function") return request;
    const requiredRole = request?.required_role ?? request?.ticket?.required_role ?? request?.payload?.required_role ?? request?.payload?.ticket?.required_role ?? fallback?.required_role ?? fallback?.ticket?.required_role;
    const profile = agentResolver.resolveAvailable(requiredRole);
    if (!profile) throw Object.assign(new ConfigurationError(requiredRole ? `No ready enabled Agent Profile found for role: ${requiredRole}.` : "No ready enabled Agent Profile is available."), { code: "AGENT_NOT_AVAILABLE", required_role: requiredRole });
    return { ...request, agent_id: profile.agent_id, selected_agent_id: profile.agent_id, selected_agent_role: profile.role };
  }
  // Retains the same durable Coder claim on retries and refuses another ticket's claim.
  async function claimCoder(request) {
    if (!agentOccupancy || (request.selected_agent_role ?? request.required_role ?? request.ticket?.required_role) !== "coder") return request;
    const existing = agentOccupancy.getByTask(runtime.taskId);
    const candidates = existing ? [existing.agent_id] : [request.agent_id, ...(agentResolver?.list?.("coder") ?? []).map((profile) => profile.agent_id)];
    for (const agentId of [...new Set(candidates.filter(Boolean))]) {
      const claim = await agentOccupancy.claim({ agentId, taskId: runtime.taskId, supervisorId: runtime.supervisorId });
      if (claim) return { ...request, agent_id: agentId, selected_agent_id: agentId, selected_agent_role: "coder", claim_id: claim.claim_id, claim_created: claim.created === true };
    }
    throw Object.assign(new ConfigurationError("No unclaimed READY Coder is available."), { code: "AGENT_NOT_AVAILABLE" });
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
    if (event.type === "verification.passed") {
      if (!agentOccupancy) { await runtime.transition("COMPLETED", event); await terminal("task.completed", event); return true; }
      const source = await sourceRequest?.(runtime.taskId);
      if (!source?.ticket) return escalate(event, "review_context_unavailable");
      await runtime.transition("REVIEWING", event);
      await senderQueue.enqueue({ operation: "review", role: "reviewer", task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: `REVIEW-${event.request_id}`, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, agent_id: agentOccupancy.getByTask(runtime.taskId)?.agent_id ?? source.agent_id, payload: { ticket: source.ticket, execution_context: event.payload?.execution_context ?? source.execution_context ?? null, changed_paths: event.payload?.passed_paths?.map((item) => item.path) ?? event.payload?.changed_paths ?? [], base_commit: source.review_base_commit ?? source.payload?.review_base_commit ?? null, verification: event.payload } });
      return true;
    }
    if (event.type === "verification.failed") { await runtime.transition("REPAIRING", event); const request = await startRepairRound(event, "verification"); return { handled: true, request }; }
    if (event.type === "review.approved") {
      if (event.payload?.verdict !== "approved" || !event.payload?.reviewer_id || event.payload.reviewer_id === agentOccupancy?.getByTask(runtime.taskId)?.agent_id) return escalate(event, "review_verdict_invalid");
      try { await integrateTicket?.(runtime.taskId); }
      catch (error) { return escalate(event, error.code ?? "TICKET_INTEGRATION_FAILED"); }
      await runtime.transition("COMPLETED", event); await terminal("task.completed", event, { review: event.payload }); await releaseCoder("accepted"); return true;
    }
    if (event.type === "review.request_changes") {
      if (event.payload?.verdict !== "request_changes" || !event.payload?.reviewer_id || !Array.isArray(event.payload?.findings) || !event.payload.findings.length) return escalate(event, "review_verdict_invalid");
      const source = await sourceRequest?.(runtime.taskId);
      const limit = source?.ticket?.execution_policy?.max_review_revisions ?? 2;
      if ((event.attempt ?? 1) > limit) return escalate(event, "review_revision_limit");
      await runtime.transition("REPAIRING", event);
      const request = await startRepairRound(event, "review_request_changes");
      return { handled: true, request };
    }
    if (event.type === "review.failed") return escalate(event, event.payload?.error?.code ?? "review_failed");
    if (event.type === "agent.response.failed") { await runtime.transition("FAILED", event); await terminal("task.failed", event); await releaseCoder("agent_failed"); return true; }
    return false;
  }
  // Repair is a first-class supervised attempt: the attempt builder builds and
  // persists attempt N (N > 1) into Protocol Storage, then the request is queued
  // for the Session Runner. Nothing here sends or persists directly.
  async function startRepairRound(event, reason) {
    let request;
    if (typeof attemptBuilder?.requestRepair === "function") request = await attemptBuilder.requestRepair({ ...event, reason });
    else {
      const source = await sourceRequest?.(runtime.taskId);
      if (!source?.ticket) return escalate(event, "repair_context_unavailable");
      const attempt = (event.attempt ?? 1) + 1;
      request = { ...source, request_id: `REQ-${runtime.taskId}-ATTEMPT-${attempt}`, attempt, payload: { ...source.payload, text: `Revise the same ticket within its original scope. Ticket: ${JSON.stringify(source.ticket)}. Reason: ${reason}. Findings: ${JSON.stringify(event.payload?.findings ?? event.payload?.failed_paths ?? [])}`, review_findings: event.payload?.findings ?? [] } };
    }
    await runtime.transition("RUNNING", request);
    await senderQueue.enqueue(request);
    return request;
  }
  async function terminal(type, event, payload = {}) { await eventBus.publish({ type, task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, payload }); }
  // Escalates missing review evidence or exhausted revision policy without approving the ticket.
  async function escalate(event, reason) {
    await runtime.transition("NEEDS_HUMAN_REVIEW", event);
    await terminal("task.needs_human_review", event, { reason });
    await releaseCoder(reason);
    return { handled: true, escalated: reason };
  }
  // Releases a Coder only after a terminal outcome for the owning Supervisor.
  async function releaseCoder(reason) {
    const claim = agentOccupancy?.getByTask(runtime.taskId);
    if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId: runtime.taskId, supervisorId: runtime.supervisorId, reason });
  }
}

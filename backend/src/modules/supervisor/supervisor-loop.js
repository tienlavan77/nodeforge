// Summary: Supervisor state machine that dispatches agent requests and routes agent/collector/verification events to transitions.
import { ConfigurationError } from "../../shared/errors.js";
import { automaticReviewPolicy } from "./automatic-review-identity.js";
import { matchesTicketExecution } from "../projects/ticket-execution-identity.js";
/** Creates the supervisor loop that starts tasks and routes execution events to runtime transitions. */
export function createSupervisorLoop({ runtime, senderQueue, collectorQueue, verificationQueue, sourceRequest, eventBus, attemptBuilder, requestStore, agentResolver, agentOccupancy, integrateTicket, automaticReview, resolveTicketWorkspace, coderRecovery, ticketStatusStore } = {}) {
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
      const claim = await agentOccupancy.claim({ agentId, taskId: runtime.taskId, supervisorId: runtime.supervisorId, projectId: request.project_id ?? request.ticket?.project_id ?? request.payload?.project_id ?? request.payload?.ticket?.project_id });
      if (claim) return { ...request, agent_id: agentId, selected_agent_id: agentId, selected_agent_role: "coder", claim_id: claim.claim_id, claim_created: claim.created === true };
    }
    throw Object.assign(new ConfigurationError("No unclaimed READY Coder is available."), { code: "AGENT_NOT_AVAILABLE" });
  }
  async function onEvent(event) {
    if (event.supervisor_id !== runtime.supervisorId) return false;
    if (event.payload?.automatic_review && (event.payload.review_gate === "off" || event.payload.inline_review)) return true;
    if (event.type === "agent.response.failed" && sourceRequest) {
      const request = await sourceRequest?.(runtime.taskId, event.request_id);
      const current = ticketStatusStore?.get(runtime.taskId);
      if (current?.details?.execution_id && (!request || !matchesTicketExecution(current, request.payload?.execution_id, request.payload?.sprint_basis))) return true;
      if (request && coderRecovery) {
        const workspace = await resolveTicketWorkspace?.(runtime.taskId);
        const failedRequest = workspace ? { ...request, execution_context: await workspace.executionContexts.load(runtime.taskId) } : request;
        if ((await coderRecovery.handleFailure({ request: failedRequest, error: event.payload?.error, source: "agent_event" })).handled) return true;
      }
    }
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
      let job;
      let preparationFailure;
      if (automaticReview) {
        const source = await sourceRequest(runtime.taskId);
        automaticReviewPolicy(source.ticket);
        event = { ...event, payload: { ...event.payload, execution_id: source.payload?.execution_id ?? event.payload?.execution_id, execution_basis: source.payload?.sprint_basis ?? event.payload?.execution_basis } };
        const workspace = await resolveTicketWorkspace(runtime.taskId);
        await workspace.reportService.assertCoderReport(runtime.taskId);
        const artifact = await workspace.testService.assertPassedArtifact();
        try { job = await automaticReview.prepare({ request: { ...source, supervisor_id: runtime.supervisorId, attempt: event.attempt }, artifact, workspace, inline: false }); }
        catch (error) {
          preparationFailure = { automatic_review: true, inline_review: true, review_gate: automaticReviewPolicy(source.ticket).gate, outcome_label: "review_failed", error: { code: error.code ?? "REVIEW_FAILED", message: error.message }, artifact_id: artifact.artifact_id };
          if (preparationFailure.review_gate === "on") { await runtime.transition("REVIEWING", event); await terminal("review.failed", event, preparationFailure); return parkReview(event, preparationFailure.error.code); }
        }
        if (job?.review_policy.gate === "on") { await runtime.transition("REVIEWING", event); await automaticReview.dispatch(job); return true; }
      }
      if (job) await automaticReview.recordCompletion(job, { verification: event.payload, completion: "coder_verified" });
      try { await integrateTicket?.(runtime.taskId); }
      catch (error) { return escalate(event, error.code ?? "TICKET_INTEGRATION_FAILED"); }
      await runtime.transition("COMPLETED", event);
      if (job) await automaticReview.publishCompletion(job);
      else await terminal("task.completed", event, { verification: event.payload, completion: "coder_verified" });
      await releaseCoder("coder_completed");
      if (preparationFailure) await terminal("review.failed", event, preparationFailure);
      if (job) await automaticReview.dispatch(job);
      return true;
    }
    if (event.type === "verification.failed") {
      if (event.payload?.error && event.payload.repairable !== true) return escalate(event, event.payload.error.code ?? "VERIFY_DIAGNOSTIC_REQUIRED");
      await runtime.transition("REPAIRING", event); const request = await startRepairRound(event, "verification"); return { handled: true, request };
    }
    if (event.type === "review.approved") {
      if (event.payload?.verdict !== "approved" || !event.payload?.reviewer_id || event.payload.reviewer_id === agentOccupancy?.getByTask(runtime.taskId)?.agent_id) return parkReview(event, "review_verdict_invalid");
      let approvedJob;
      try {
        if (event.payload?.automatic_review) { await automaticReview.assertApproval(event.payload); approvedJob = await automaticReview.findJob(event.payload.job_key); await automaticReview.recordCompletion(approvedJob, { review: event.payload, completion: "reviewed" }); }
        await integrateTicket?.(runtime.taskId, { reviewed: true });
      }
      catch (error) { return parkReview(event, error.code ?? "TICKET_INTEGRATION_FAILED"); }
      await runtime.transition("COMPLETED", event); if (approvedJob) await automaticReview.publishCompletion(approvedJob); else await terminal("task.completed", event, { review: event.payload }); await releaseCoder("accepted"); return true;
    }
    if (event.type === "review.request_changes") {
      if (event.payload?.verdict !== "request_changes" || !event.payload?.reviewer_id || !Array.isArray(event.payload?.findings) || (!event.payload.findings.length && !(event.payload.adjudications ?? []).some((item) => ["retain", "refine", "reopen"].includes(item.decision)))) return parkReview(event, "review_verdict_invalid");
      if (event.payload.owner_decision_reason) return parkReview(event, event.payload.owner_decision_reason);
      if (event.payload?.automatic_review) await automaticReview.consumeRepair(await automaticReview.findJob(event.payload.job_key));
      await runtime.transition("REPAIRING", event);
      const repairEvent = event.payload?.automatic_review ? { ...event, payload: { ...event.payload, findings: await (await resolveTicketWorkspace(runtime.taskId)).reviewFindings.unresolved() } } : event;
      const request = await startRepairRound(repairEvent, "review_request_changes");
      return { handled: true, request };
    }
    if (["review.failed", "review.unavailable"].includes(event.type)) return parkReview(event, event.payload?.error?.code ?? "review_failed");
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
      request = { ...source, request_id: `REQ-${runtime.taskId}-ATTEMPT-${attempt}`, attempt, payload: { ...source.payload, text: `Revise the same ticket within its original scope. Ticket: ${JSON.stringify(source.ticket)}. Reason: ${reason}. Findings: ${JSON.stringify(event.payload?.findings ?? event.payload?.verification_diagnostic ?? event.payload?.failed_paths ?? [])}`, verification_diagnostic: event.payload?.verification_diagnostic, review_findings: event.payload?.findings ?? [] } };
    }
    await runtime.transition("RUNNING", request);
    await senderQueue.enqueue(request);
    return request;
  }
  async function terminal(type, event, payload = {}) { await eventBus.publish({ type, task_id: runtime.taskId, supervisor_id: runtime.supervisorId, request_id: event.request_id, correlation_id: event.correlation_id, attempt: event.attempt ?? 1, payload: { ...payload, ...(event.payload?.execution_id ? { execution_id: event.payload.execution_id, execution_basis: event.payload.execution_basis } : {}) } }); }
  // Parks review failures without failing the Coder ticket or bypassing an unresolved finding.
  async function parkReview(event, reason) {
    const parked = event.payload?.automatic_review ? await automaticReview.park(await automaticReview.findJob(event.payload.job_key), reason) : null;
    if (parked?.status === "failed") { await runtime.transition("FAILED", event); await releaseCoder(reason); return { handled: true, retryable: true }; }
    await runtime.transition("NEEDS_HUMAN_REVIEW", event);
    if (!event.payload?.automatic_review) await terminal("task.needs_human_review", event, { reason });
    await releaseCoder(reason);
    return { handled: true, escalated: reason };
  }
  // Records missing review evidence or exhausted revision policy as a resumable failure.
  async function escalate(event, reason) {
    await runtime.transition("FAILED", event);
    await terminal("task.failed", event, { reason, retryable: true });
    await releaseCoder(reason);
    return { handled: true, escalated: reason };
  }
  // Releases a Coder only after a terminal outcome for the owning Supervisor.
  async function releaseCoder(reason) {
    const claim = agentOccupancy?.getByTask(runtime.taskId);
    if (claim) await agentOccupancy.release({ claimId: claim.claim_id, taskId: runtime.taskId, supervisorId: runtime.supervisorId, reason });
  }
}

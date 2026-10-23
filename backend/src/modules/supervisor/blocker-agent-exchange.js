/** Adapts retained ticket recovery decisions to the shared communication contract
 * without replacing source, approval, candidate or Architecture validation. */
import { createAgentExchange, bindAgentExchangeResponse, agentExchangeError } from "../governance/agent-exchange.js";
import { compactBlockerPromptValue } from "./blocker-prompt-context.js";

/** Builds a focused consultation from SL's question rather than assigning AM
 * every unfinished implementation and verification responsibility in the ticket. */
export function blockerExchangeRequest(job, profile, resolver) {
  if (!job.request.project_id || !job.request.payload?.execution_id) return null;
  const sourceRole = job.stage === "architecture_manager" ? "sprint_leader" : job.stage === "coder" ? "sprint_leader" : "coder";
  const actor = job.history?.findLast((entry) => entry.stage === sourceRole && entry.actor)?.actor;
  const profiles = resolver?.list?.(sourceRole)?.filter((entry) => entry.enabled) ?? [];
  const sourceId = actor?.agent_id ?? (sourceRole === "coder" ? job.coder_checkpoint?.agent_id ?? job.request.agent_id : null)
    ?? (profiles.length === 1 ? profiles[0].agent_id : null);
  const original = job.authority_consultations?.findLast((entry) => entry.status === "assigned")?.original_resolution;
  const resolution = original ?? job.resolution ?? {};
  const questions = resolution.reconciliation?.waiting_for?.map((entry) => typeof entry === "string" ? entry : entry.question).filter(Boolean);
  const question = questions?.join("\n") || resolution.reconciliation?.next_check || resolution.guidance || resolution.summary || job.message || job.reason_code
    || job.request.ticket?.objective || "Identify the specific unresolved prerequisite for this retained ticket.";
  const known = job.architecture_response ? [{ section: "architecture_response", answered_at: job.architecture_response.answered_at }] : [];
  const payload = job.stage === "coder"
    ? { objective: job.coder_exchange?.request?.questions?.join("\n") || question,
      criterion_ids: job.coder_exchange?.request?.criterion_ids ?? [], decision_refs: known,
      remaining_work: job.coder_exchange?.request?.questions ?? [question], expected_outputs: ["Read-only candidate proposal; no implementation, commit or approval."] }
    : job.stage === "architecture_manager" && job.consultation_request ? job.consultation_request
      : job.stage === "sprint_leader" && !job.resolution && !job.architecture_response && job.coder_consultation ? job.coder_consultation
      : { question, decision_needed: resolution.reconciliation?.next_check || resolution.summary || question,
      known_decision_refs: known, impact: resolution.reconciliation?.prerequisite || job.reason_code || "The retained ticket cannot continue until this question is answered." };
  return createAgentExchange({ context: { project_id: job.request.project_id, ticket_id: job.request.task_id, execution_id: job.request.payload.execution_id },
    sender: { agent_id: sourceId, role: sourceRole }, recipient: { agent_id: profile.agent_id, role: profile.role },
    kind: job.stage === "coder" ? "work_request" : "consultation_request", subject: resolution.summary || `Resolve ${job.reason_code || job.request.task_id}`,
    payload, continuation: { assignment_id: `${job.id}:${job.stage}`, checkpoint_ref: job.coder_checkpoint?.ref ?? null } });
}

/** Converts only explicit structured outcomes into existing disposition actions;
 * no narrative keyword matching can dispatch or approve another agent. */
export function blockerExchangeResponse(value, request) {
  if (!request) return { value, response: null };
  if (!value || typeof value !== "object" || Array.isArray(value)) throw agentExchangeError("/", "type", "Return one structured response object.");
  const content = value.kind ? value : legacyContent(value, request);
  const response = bindAgentExchangeResponse(content, request);
  if (response.kind === "work_result") {
    if (response.payload.outcome === "blocked" && response.payload.consultation) return { response,
      value: { action: "architecture_required", summary: response.payload.summary, guidance: response.payload.consultation.question } };
    if (!response.payload.candidate) throw agentExchangeError("/payload/candidate", "candidate_required", "Supply the requested candidate, not a completion claim.");
    return { value: { action: "candidate_prepared", summary: response.subject, candidate: response.payload.candidate }, response };
  }
  const payload = response.payload;
  const decision = payload.decision;
  if (!decision) throw agentExchangeError("/payload/decision", "required", "This recovery assignment requires its existing source-bound disposition in payload.decision.");
  const expected = outcome(decision.action);
  if (payload.outcome !== expected) throw agentExchangeError("/payload/outcome", "decision_mismatch", "Outcome must agree with the source-bound decision action.");
  const evidence = response.evidence.map((entry) => ({ path: entry.ref, sha256: entry.sha256?.replace(/^sha256:/, "") })).filter((entry) => entry.sha256);
  return { response, value: { ...decision, summary: payload.answer, guidance: payload.next_steps.join("\n") || payload.answer,
    ...(payload.consultation && decision.action === "architecture_required" ? { reconciliation: { kind: "technical_design",
      prerequisite: payload.consultation.impact, completed_checks: [payload.rationale], next_check: payload.consultation.decision_needed,
      waiting_for: [{ owner: "architecture_manager", operation: "inspect", question: payload.consultation.question }] } } : {}),
    ...(decision.evidence ? {} : evidence.length ? { evidence } : {}) } };
}

/** Projects validated legacy transport fields for in-flight checkpoints; the
 * resulting envelope uses the same route checks as newly authored responses. */
function legacyContent(value, request) {
  if (request.kind === "work_request") return { kind: "work_result", subject: value.summary,
    payload: { outcome: value.action === "architecture_required" ? "blocked" : "completed", summary: value.summary, change_refs: [], verification_refs: [], report_ref: null, remaining_work: [],
      ...(value.candidate ? { candidate: value.candidate } : { consultation: { question: value.guidance || value.summary,
        decision_needed: value.summary, impact: value.summary, known_decision_refs: [] } }) }, evidence: [] };
  const result = outcome(value.action);
  const payload = { outcome: result, answer: value.summary, rationale: value.authority_reference?.rationale || value.summary,
    authority_refs: value.authority_reference ? [value.authority_reference] : [], next_steps: value.guidance ? [value.guidance] : [], decision: value };
  if (result === "needs_evidence") payload.missing_evidence = [{ needed: value.reconciliation?.prerequisite || value.guidance || value.summary,
    needed_for: value.reconciliation?.next_check || value.summary }];
  if (result === "needs_higher_authority") {
    payload.consultation = { question: value.guidance || value.summary, decision_needed: value.summary, known_decision_refs: [], impact: value.summary };
    if (value.action === "owner_required") payload.consultation.owner_boundary_risk = {
      boundary: value.boundary_assessment?.changes_structure === true ? "system_structure" : "approved_scope",
      proposed_change: value.guidance || value.summary, rationale: value.boundary_assessment?.rationale || value.summary,
      evidence_refs: (value.evidence ?? []).map((entry) => entry.path) };
  }
  return { kind: "consultation_response", subject: value.summary, payload, evidence: [] };
}

/** Maps the existing explicit disposition enum to shared result semantics;
 * unsupported actions remain errors instead of silently resuming implementation. */
function outcome(action) {
  if (["resolved", "sprint_required"].includes(action)) return "answered";
  if (["reconciliation_required", "coder_requested"].includes(action)) return "needs_evidence";
  if (["architecture_required", "owner_required", "governance_required"].includes(action)) return "needs_higher_authority";
  throw agentExchangeError("/payload/decision/action", "action_invalid", "Return a supported explicit recovery action.");
}

/** Keeps the request visible first while pointing to exact full sections if an
 * unusually long question exceeds the display window. */
export function blockerExchangeDisplay(request) {
  return { ...request, payload: compactBlockerPromptValue(request.payload), subject: request.subject.slice(0, 800) };
}

/** Keeps corrections limited to validator-known fields so Node-supplied
 * authority, identity or schema feedback can be applied without rediscovery. */
export function blockerFormatCorrection(job) {
  return Boolean(job.validation_feedback?.length && job.validation_feedback.every((entry) =>
    ["json_invalid", "schema_invalid", "required", "additionalProperties", "type", "enum", "unexpected_field", "response_kind_mismatch", "binding_mismatch",
      "identity_mismatch", "identity_shape_invalid", "authority_not_grounded", "reference_invalid", "reference_unknown", "reference_scope_mismatch",
      "boundary_not_preserved", "assessment_invalid", "boundary_inflation_forbidden", "delegated_to_architecture", "escalation_boundary_mismatch",
      "technical_result_incomplete"].includes(entry.reason)));
}

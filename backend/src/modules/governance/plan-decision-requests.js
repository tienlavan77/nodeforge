// Presents Sprint policy proposals and binds owner choices to exact immutable plan approval before dispatch.
import { ConfigurationError } from "../../shared/errors.js";
import { assertNoSprintPolicyRequests } from "./sprint-architecture-decisions.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
// Defines text function behavior for plan-decision-requests.js.
const text = (value) => typeof value === "string" && value.trim().length > 0;

// Returns actionable approval failures without granting implicit policy authority.
function fail(code, message) { return Object.assign(new ConfigurationError(message), { code, statusCode: 409 }); }

// Validates proposals and exposes human prerequisites omitted by Sprint Leader as unresolved decisions.
export function planDecisionRequests(content = {}) {
  assertNoSprintPolicyRequests(content);
  if (content.architecture_decisions) return [];
  const tickets = content.ticket_specs ?? [];
  if (content.decision_requests !== undefined && !Array.isArray(content.decision_requests)) throw fail("PLAN_DECISION_PROPOSALS_INVALID", "Decision requests must be an array.");
  const requests = structuredClone(content.decision_requests ?? []);
  const ids = new Set();
  for (const request of requests) {
    if (!request || !ID.test(request.id ?? "") || ids.has(request.id) || !text(request.title) || !text(request.reason)
      || !Array.isArray(request.ticket_ids) || !request.ticket_ids.length || new Set(request.ticket_ids).size !== request.ticket_ids.length
      || request.ticket_ids.some((id) => !tickets.some((ticket) => ticket.id === id))
      || !Array.isArray(request.criterion_ids) || new Set(request.criterion_ids).size !== request.criterion_ids.length
      || request.criterion_ids.some((id) => !/^AC-[1-9]\d*$/.test(id) || request.ticket_ids.some((ticketId) => Number(id.slice(3)) > (tickets.find((ticket) => ticket.id === ticketId).acceptance_criteria ?? []).length))
      || !Array.isArray(request.options) || request.options.some((option) => !option || !ID.test(option.id ?? "") || !text(option.label) || !text(option.description))
      || new Set(request.options.map((option) => option.id)).size !== request.options.length
      || request.recommended_option_id != null && !request.options.some((option) => option.id === request.recommended_option_id)) throw fail("PLAN_DECISION_PROPOSALS_INVALID", "Policy proposals require unique IDs, affected tickets/criteria and concrete options.");
    ids.add(request.id);
  }
  for (const ticket of tickets) {
    for (const [index, step] of (ticket.verification_plan ?? []).entries()) {
      if (step.kind !== "human") continue;
      const missing = (step.criterion_ids ?? []).filter((criterion) => !requests.some((request) => request.ticket_ids.includes(ticket.id) && request.criterion_ids.includes(criterion)));
      if (!missing.length) continue;
      const id = `DECISION-${ticket.id}-${index + 1}`;
      if (ids.has(id)) throw fail("PLAN_DECISION_PROPOSALS_INVALID", "Unresolved human prerequisite conflicts with a proposal ID.");
      requests.push({ id, title: `Owner decision required: ${ticket.title ?? ticket.id}`, reason: (step.assertions ?? []).join("\n") || "Record the required owner policy before dispatch.", ticket_ids: [ticket.id], criterion_ids: missing, options: [], recommended_option_id: null });
      ids.add(id);
    }
  }
  return requests;
}

// Requires explicit supported choices for every proposal in this reviewed revision.
export function validatePlanDecisionSelections(requests, selections = {}) {
  if (!selections || typeof selections !== "object" || Array.isArray(selections) || Object.keys(selections).some((id) => !requests.some((request) => request.id === id))) throw fail("PLAN_DECISION_SELECTION_INVALID", "Selections must belong to this plan's requests.");
  const result = {};
  for (const request of requests) {
    if (!request.options.length) throw fail("PLAN_DECISION_PROPOSALS_REQUIRED", `Sprint Leader must propose options for ${request.id} before approval.`);
    if (!Object.hasOwn(selections, request.id) || !request.options.some((option) => option.id === selections[request.id])) throw fail("PLAN_OWNER_DECISIONS_REQUIRED", `Choose a policy for ${request.title} before approval.`);
    result[request.id] = selections[request.id];
  }
  return result;
}

// Prevents inherited Architecture approval or another revision from authorizing Sprint-specific policies.
export function assertPlanOwnerDecisions(plan) {
  const requests = planDecisionRequests(plan.content);
  if (!requests.length) return;
  const decision = plan.decision;
  if (plan.status !== "approved" || decision?.decision !== "approved" || decision.plan_id !== plan.plan_id || decision.revision !== plan.revision || decision.sha256 !== plan.sha256 || !decision.approver_id) throw fail("PLAN_OWNER_DECISIONS_REQUIRED", "This Sprint Plan needs exact owner approval of its policy choices before dispatch.");
  validatePlanDecisionSelections(requests, decision.selections);
}

// Supplies authenticated owner choices to Coder without changing the immutable ticket specification.
export function approvedTicketDecisions(plan, ticketId) {
  assertPlanOwnerDecisions(plan);
  const inherited = plan.content.architecture_decisions;
  if (inherited) return inherited.decisions.map((entry) => ({ ...entry, request_id: entry.id, ticket_id: ticketId, plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, decision_id: inherited.approval_decision_id, approver_id: inherited.approver_id, criterion_ids: [], architecture_plan_id: inherited.parent_plan_id }));
  return planDecisionRequests(plan.content).filter((request) => request.ticket_ids.includes(ticketId)).map((request) => {
    const option = request.options.find((entry) => entry.id === plan.decision.selections[request.id]);
    return { ticket_id: ticketId, plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, decision_id: plan.decision.decision_id, approver_id: plan.decision.approver_id, request_id: request.id, title: request.title, criterion_ids: request.criterion_ids, option_id: option.id, label: option.label, description: option.description };
  });
}

// Recognizes human prerequisites only from Node's plan-bound approval context, not Coder input.
export function hasOwnerDecisionEvidence(ticket, criterionId) {
  const basis = ticket.owner_decision_basis;
  return Boolean(basis?.plan_id && basis.decision_id && basis.sha256 && (ticket.owner_decisions ?? []).some((entry) => entry.ticket_id === ticket.id && entry.plan_id === basis.plan_id && entry.revision === basis.revision && entry.sha256 === basis.sha256 && entry.decision_id === basis.decision_id && entry.approver_id && entry.criterion_ids.includes(criterionId)));
}

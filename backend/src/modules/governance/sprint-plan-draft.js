// Converts a Sprint Leader proposal into the reviewable scope of an immutable human plan.

// Preserves list-based plan sections as readable canonical text in the immutable artifact.
function planText(value) { return Array.isArray(value) ? value.join("\n") : value; }

// Keeps executable ticket details in the approved plan so later roadmap edits cannot expand scope.
export function sprintPlanDraftContent(plan) {
  const tickets = plan.tickets ?? [];
  const review = plan.human_plan;
  if (!review || !Array.isArray(review.evidence_refs) || !review.evidence_refs.length || !Array.isArray(review.components) || !review.components.length) {
    throw Object.assign(new Error("Sprint Leader must provide reviewable scope, approach, components, and evidence references."), { code: "PLAN_DRAFT_INCOMPLETE", statusCode: 409 });
  }
  return {
    objective: plan.objective,
    outcome: review.outcome,
    in_scope: planText(review.in_scope),
    out_of_scope: planText(review.out_of_scope),
    approach: planText(review.approach),
    components: review.components,
    tickets: tickets.map((ticket) => ticket.id),
    ticket_specs: structuredClone(tickets),
    dependencies: tickets.flatMap((ticket) => ticket.dependencies ?? []).filter((id, index, all) => all.indexOf(id) === index),
    risks: review.risks,
    assumptions: review.assumptions,
    open_questions: review.open_questions,
    evidence_refs: review.evidence_refs,
    acceptance_criteria: review.acceptance_criteria
  };
}

// Rejects ticket scope drift between the approved plan and the execution projection.
export function assertApprovedTicket(plan, ticket) {
  if (!plan.content.tickets.includes(ticket.id)) throw Object.assign(new Error("Ticket is absent from the approved sprint plan."), { code: "TICKET_PLAN_SCOPE", statusCode: 409 });
  const spec = plan.content.ticket_specs?.find((item) => item.id === ticket.id);
  if (!spec) return;
  const fields = ["title", "objective", "acceptance_criteria", "dependencies", "implementation_type", "execution_contract"];
  if (fields.some((field) => JSON.stringify(spec[field] ?? null) !== JSON.stringify(ticket[field] ?? null))) {
    throw Object.assign(new Error("Ticket scope differs from the approved sprint plan; create and approve a new plan revision."), { code: "TICKET_PLAN_SCOPE", statusCode: 409 });
  }
}

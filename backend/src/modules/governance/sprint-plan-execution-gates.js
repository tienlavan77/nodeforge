// Checks immutable Sprint membership and A5 contract before dispatching any ticket work.

// Requires the persisted A5 authorities, verification plan, and shadow gate before RUN.
export function assertA5ExecutionContract(ticket) {
  if (ticket?.rollout_package !== "A5") return;
  const contract = ticket.execution_contract;
  const required = ["scope", "owner", "supervisor", "coder", "reviewer", "gate", "ledger_revision", "idempotency_key"];
  if (!contract || required.some((field) => typeof contract[field] !== "string" || !contract[field].trim())
    || contract.gate !== "shadow" || !Array.isArray(contract.acceptance_criteria) || !contract.acceptance_criteria.length
    || !Array.isArray(contract.verification_plan) || !contract.verification_plan.length || !Array.isArray(contract.dependencies)
    || !(contract.human_authority === null || typeof contract.human_authority === "string")) {
    throw Object.assign(new Error("A5 RUN requires a persisted execution contract with scope, acceptance, verification, authorities, shadow gate, ledger revision, and idempotency key."), { code: "A5_EXECUTION_CONTRACT_REQUIRED", statusCode: 409 });
  }
}

// Rejects a Sprint projection that adds, drops, or duplicates approved ticket IDs.
export function assertSprintTicketMembership(plan, tickets) {
  const planned = plan?.content?.tickets;
  if (!Array.isArray(planned) || !Array.isArray(tickets) || planned.some((id) => typeof id !== "string" || !id.trim()) || tickets.some((ticket) => !ticket || typeof ticket.id !== "string" || !ticket.id.trim())) {
    throw Object.assign(new Error("Sprint ticket membership contains malformed IDs."), { code: "SPRINT_PLAN_SCOPE", statusCode: 409 });
  }
  const plannedIds = [...planned];
  const projectionIds = tickets.map((ticket) => ticket.id);
  if (new Set(plannedIds).size !== plannedIds.length || new Set(projectionIds).size !== projectionIds.length || plannedIds.length !== projectionIds.length || plannedIds.some((id) => !projectionIds.includes(id)) || projectionIds.some((id) => !plannedIds.includes(id))) {
    throw Object.assign(new Error("Sprint ticket membership differs from its approved plan."), { code: "SPRINT_PLAN_SCOPE", statusCode: 409 });
  }
}

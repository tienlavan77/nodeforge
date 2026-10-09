// Preserves the observed Sprint execution basis through the production ticket submission boundary.
import { assertApprovedTicket } from "../modules/governance/sprint-plan-draft.js";
import { matchesTicketExecution } from "../modules/projects/ticket-execution-identity.js";

// Rejects obsolete RUN intent instead of silently submitting against a newly bound Sprint revision.
export function createApprovedTicketDispatch({ projectId, sprintRegistry, ticketStatusStore, integration }) {
  return dispatchTask;

  // Revalidates the caller's exact basis and records it with the submitted supervisor payload.
  async function dispatchTask({ ticket, sprintBasis, executionId, message, required_role, resume_from, review_resume, abortSignal } = {}) {
    if (!sprintBasis || !Number.isSafeInteger(sprintBasis.version) || sprintBasis.project_id !== projectId || ticket?.project_id !== projectId || sprintBasis.sprint_id !== ticket.sprint_id) {
      throw Object.assign(new Error("Ticket RUN requires its observed project Sprint basis."), { code: "TICKET_RUN_BASIS_REQUIRED", statusCode: 409, retryable: false, scope: "scoped" });
    }
    const { sprint, plan } = await sprintRegistry.assertReady(ticket.sprint_id, { expectedVersion: sprintBasis.version });
    const fields = ["project_id", "sprint_id", "version", "plan_id", "plan_revision", "plan_path", "plan_sha256"];
    if (fields.some((field) => sprint[field] !== sprintBasis[field])) throw Object.assign(new Error("Ticket RUN basis differs from its observed immutable Sprint binding."), { code: "SPRINT_REGISTRY_CONFLICT", statusCode: 409, retryable: false, scope: "scoped", identifiers: [ticket.sprint_id] });
    assertApprovedTicket(plan, ticket);
    if (ticketStatusStore && !matchesTicketExecution(ticketStatusStore.get(ticket.id), executionId, sprintBasis)) throw Object.assign(new Error("Ticket RUN no longer owns its durable execution claim."), { code: "TICKET_EXECUTION_CONFLICT", statusCode: 409, retryable: false, scope: "scoped", identifiers: [ticket.id] });
    if (abortSignal?.aborted) throw abortSignal.reason;
    const admittedBasis = Object.fromEntries(fields.map((field) => [field, sprint[field]]));
    return integration.submitTicket({
      ticket, task_id: ticket.id, project_id: ticket.project_id, request_id: message?.id, correlation_id: message?.correlation_id,
      required_role: required_role ?? ticket.required_role ?? "coder", abortSignal,
      payload: {
        text: `Ticket ${ticket.id}: ${ticket.title ?? ""}\nObjective: ${ticket.objective ?? ""}\nAcceptance: ${(ticket.acceptance_criteria ?? []).join("; ")}`,
        task: { id: ticket.id, title: ticket.title, objective: ticket.objective, dependencies: ticket.dependencies ?? [], acceptance_criteria: ticket.acceptance_criteria ?? [] },
        ticket, sprint_basis: admittedBasis, ...(executionId ? { execution_id: executionId } : {}),
        ...(resume_from ? { resume_from } : {}),
        ...(review_resume ? { review_resume, review_base_commit: review_resume.base_commit } : {})
      }
    });
  }
}

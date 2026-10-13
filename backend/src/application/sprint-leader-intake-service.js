// Enforces Sprint Leader intake rules before a dependency-gated ticket is dispatched.
import { ConfigurationError } from "../shared/errors.js";
import { assertApprovedTicket } from "../modules/governance/sprint-plan-draft.js";
import { assertPlanOwnerDecisions } from "../modules/governance/plan-decision-requests.js";
import { captureDependencyExpectations } from "../modules/supervisor/ticket-dependency-expectations.js";

// Creates a small intake guard that keeps Sprint Leader decisions within the approved DAG.
export function createSprintLeaderIntakeService({ fileService, roadmaps, sprintRegistry, ticketStatusStore, logger = () => {} } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("Sprint Leader Intake requires File Service.");
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Sprint Leader Intake requires a Roadmap Store.");
  return Object.freeze({ open });

  // Reads the Sprint Leader contract and opens only a ticket whose dependencies are done.
  async function open({ projectId, ticketId } = {}) {
    if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Sprint Leader Intake requires project_id.");
    if (typeof ticketId !== "string" || !ticketId) throw new ConfigurationError("Sprint Leader Intake requires ticket_id.");
    const rules = await fileService.readForIndex({ path: "workflows/agents/sprint-leader/README.md", maxBytes: 32_000 });
    if (!rules?.content) throw Object.assign(new ConfigurationError("Sprint Leader rules could not be loaded."), { code: "SPRINT_LEADER_RULES_UNAVAILABLE" });
    if (sprintRegistry) {
      const record = await sprintRegistry.getByTicket(ticketId);
      if (!record || record.project_id !== projectId) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404, code: "TICKET_NOT_FOUND" });
      const { plan } = await sprintRegistry.assertReady(record.sprint_id, { expectedVersion: record.version });
      const ticket = structuredClone(plan.content.ticket_specs?.find((item) => item.id === ticketId));
      if (!ticket) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404, code: "TICKET_NOT_FOUND" });
      if (ticket.project_id !== projectId || ticket.sprint_id !== record.sprint_id) throw Object.assign(new ConfigurationError("Immutable ticket ownership differs from its registered Sprint."), { statusCode: 409, code: "SPRINT_PLAN_MISMATCH" });
      assertApprovedTicket(plan, ticket);
      assertPlanOwnerDecisions(plan);
      await captureDependencyExpectations({ projectId, ticket, sprintRegistry, ticketStatusStore });
      emit({ event_name: "sprint.ticket_intake_ready", level: "info", message: "Sprint Leader opened an approved Registry ticket.", project_id: projectId, task_id: ticketId, payload: { ticket_id: ticketId, dependencies: ticket.dependencies ?? [], rules_path: "workflows/agents/sprint-leader/README.md" } });
      return { ticket, dependencies: ticket.dependencies ?? [], rules_path: "workflows/agents/sprint-leader/README.md" };
    }
    const ticket = roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).find((item) => item.id === ticketId && item.project_id === projectId);
    if (!ticket) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { statusCode: 404, code: "TICKET_NOT_FOUND" });
    const dependencies = ticket.dependencies ?? [];
    const byId = new Map(roadmaps.getCurrent()?.sprints?.flatMap((sprint) => sprint.tickets ?? []).map((item) => [item.id, item]) ?? []);
    const blockedBy = dependencies.map((id) => ({ id, status: byId.get(id)?.status ?? "not_found" })).filter((entry) => entry.status !== "done");
    if (blockedBy.length) {
      emit({ event_name: "sprint.ticket_blocked", level: "info", message: "Sprint Leader dependency gate blocked ticket intake.", project_id: projectId, task_id: ticketId, payload: { ticket_id: ticketId, blocked_by: blockedBy } });
      throw Object.assign(new ConfigurationError(`Ticket ${ticketId} is blocked by unfinished dependencies.`), { code: "SPRINT_DEPENDENCIES_NOT_READY", blocked_by: blockedBy });
    }
    emit({ event_name: "sprint.ticket_intake_ready", level: "info", message: "Sprint Leader opened a dependency-ready ticket.", project_id: projectId, task_id: ticketId, payload: { ticket_id: ticketId, dependencies, rules_path: "workflows/agents/sprint-leader/README.md" } });
    return { ticket, dependencies, rules_path: "workflows/agents/sprint-leader/README.md" };
  }

  // Emits intake audit records with the project log envelope required by Node.
  function emit(entry) {
    logger({ timestamp: new Date().toISOString(), source: "sprint-leader-intake", status: "info", ...entry });
  }
}

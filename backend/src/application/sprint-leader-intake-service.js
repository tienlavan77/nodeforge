// Enforces Sprint Leader intake rules before a dependency-gated ticket is dispatched.
import { ConfigurationError } from "../shared/errors.js";

// Creates a small intake guard that keeps Sprint Leader decisions within the approved DAG.
export function createSprintLeaderIntakeService({ fileService, roadmaps, logger = () => {} } = {}) {
  if (typeof fileService?.readForIndex !== "function") throw new ConfigurationError("Sprint Leader Intake requires File Service.");
  if (typeof roadmaps?.getCurrent !== "function") throw new ConfigurationError("Sprint Leader Intake requires a Roadmap Store.");
  return Object.freeze({ open });

  // Reads the Sprint Leader contract and opens only a ticket whose dependencies are done.
  async function open({ projectId, ticketId } = {}) {
    if (typeof projectId !== "string" || !projectId) throw new ConfigurationError("Sprint Leader Intake requires project_id.");
    if (typeof ticketId !== "string" || !ticketId) throw new ConfigurationError("Sprint Leader Intake requires ticket_id.");
    const rules = await fileService.readForIndex({ path: "workflows/agents/sprint-leader/README.md", maxBytes: 32_000 });
    if (!rules?.content) throw Object.assign(new ConfigurationError("Sprint Leader rules could not be loaded."), { code: "SPRINT_LEADER_RULES_UNAVAILABLE" });
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

// Resolves immutable ticket scope for SL, review and builder entrypoints without legacy roadmap fallback.
import { ConfigurationError } from "../shared/errors.js";

// Reads one current Registry ticket under project and scheduling identity checks.
export async function readRegistryTicket({ projectId, ticketId, sprintRegistry, requireApproval = false }) {
  const record = await sprintRegistry.getByTicket(ticketId);
  if (!record || record.project_id !== projectId) throw Object.assign(new ConfigurationError(`Unknown ticket: ${ticketId}.`), { code: "TICKET_NOT_FOUND", statusCode: 404 });
  const sprint = requireApproval ? (await sprintRegistry.assertReady(record.sprint_id, { expectedVersion: record.version })).plan : await sprintRegistry.getDetail(record.sprint_id);
  const ticket = requireApproval ? sprint.content.ticket_specs?.find((entry) => entry.id === ticketId && sprint.content.tickets.includes(entry.id)) : sprint?.tickets?.find((entry) => entry.id === ticketId);
  if (!ticket) throw Object.assign(new ConfigurationError(`Unknown immutable ticket: ${ticketId}.`), { code: "TICKET_NOT_FOUND", statusCode: 404 });
  if (ticket.project_id !== projectId || ticket.sprint_id !== record.sprint_id || sprintRegistry.get(record.sprint_id)?.version !== record.version) throw Object.assign(new ConfigurationError("Ticket Registry scope changed or differs from this project."), { code: "SPRINT_PLAN_MISMATCH", statusCode: 409 });
  return structuredClone(ticket);
}

// Rejects legacy edits rather than silently changing scope outside an immutable approved Sprint revision.
export function assertLegacyTicketMutation(sprintRegistry) {
  if (sprintRegistry) throw Object.assign(new ConfigurationError("Ticket scope is owned by Registry. Create and approve a new Sprint Plan revision to add, edit or regenerate tickets."), { code: "TICKET_REPLAN_REQUIRED", statusCode: 409 });
}

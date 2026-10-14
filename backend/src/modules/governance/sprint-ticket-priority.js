// Keeps Sprint Leader priority repairs within the ticket schema without guessing business urgency or changing approved scope.
import { createRequire } from "node:module";
import { ConfigurationError } from "../../shared/errors.js";

const require = createRequire(import.meta.url);
export const TICKET_PRIORITY_VALUES = Object.freeze([...require("../../../../schemas/governance/ticket.schema.json").properties.priority.enum]);

// Identifies explicit invalid priorities while leaving the schema's optional priority field optional.
export function invalidSprintTicketPriorities(plan) {
  if (!Array.isArray(plan?.tickets)) return [];
  return plan.tickets.flatMap((ticket, index) => ticket && Object.hasOwn(ticket, "priority") && !TICKET_PRIORITY_VALUES.includes(ticket.priority) ? [index] : []);
}

// Applies only SL-selected schema-valid priority replacements to the frozen Sprint and ticket identities.
export function repairSprintTicketPriorities(plan, repaired) {
  const invalid = invalidSprintTicketPriorities(plan);
  if (repaired?.id !== plan.id || !Array.isArray(repaired?.tickets) || repaired.tickets.length !== plan.tickets.length
    || repaired.tickets.some((ticket, index) => ticket?.id !== plan.tickets[index]?.id)) {
    throw Object.assign(new ConfigurationError("Priority repair must preserve the Sprint and ordered ticket IDs."), { code: "SPRINT_PRIORITY_REPAIR_IDENTITY", statusCode: 422 });
  }
  if (invalid.some((index) => !TICKET_PRIORITY_VALUES.includes(repaired.tickets[index]?.priority))) {
    throw Object.assign(new ConfigurationError(`Sprint Leader must choose a string priority from ${TICKET_PRIORITY_VALUES.join("| ")} for every rejected ticket.`), { code: "SPRINT_TICKET_PRIORITY_INVALID", statusCode: 422 });
  }
  return { ...plan, tickets: plan.tickets.map((ticket, index) => invalid.includes(index) ? { ...ticket, priority: repaired.tickets[index].priority } : ticket) };
}

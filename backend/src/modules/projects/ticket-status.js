// Provides module declarations and business logic for ticket-status.js.

import { ConfigurationError } from "../../shared/errors.js";

export const TICKET_STATUSES = Object.freeze([
  "pending",
  "blocked",
  "running",
  "reviewing",
  "done",
  "failed",
  "cancelled",
  "needs_human_review"
]);

const TRANSITIONS = {
  pending: ["blocked", "running", "cancelled"],
  blocked: ["pending", "cancelled"],
  running: ["reviewing", "done", "failed", "cancelled", "needs_human_review"],
  reviewing: ["running", "done", "failed", "cancelled", "needs_human_review"],
  done: [],
  failed: ["pending"],
  cancelled: [],
  needs_human_review: ["pending", "cancelled"]
};

export const TICKET_TRANSITIONS = Object.freeze(Object.fromEntries(
  Object.entries(TRANSITIONS).map(([status, next]) => [status, Object.freeze([...next])])
));

// Defines isTicketStatus function behavior for ticket-status.js.
export function isTicketStatus(status) {
  return typeof status === "string" && TICKET_STATUSES.includes(status);
}

// Defines canTransitionTicketStatus function behavior for ticket-status.js.
export function canTransitionTicketStatus(from, to) {
  return isTicketStatus(from) && isTicketStatus(to) && TICKET_TRANSITIONS[from].includes(to);
}

// Defines assertTicketStatus function behavior for ticket-status.js.
export function assertTicketStatus(status, field = "status") {
  if (!isTicketStatus(status)) throw statusError("STATUS_INVALID", `Invalid ticket ${field}: ${status ?? "<missing>"}.`);
  return status;
}

// Defines assertTicketStatusTransition function behavior for ticket-status.js.
export function assertTicketStatusTransition(from, to) {
  assertTicketStatus(from, "current status");
  assertTicketStatus(to, "next status");
  if (!canTransitionTicketStatus(from, to)) throw statusError("STATUS_TRANSITION_INVALID", `Invalid ticket status transition: ${from} -> ${to}.`);
  return true;
}

// Defines statusError function behavior for ticket-status.js.
function statusError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

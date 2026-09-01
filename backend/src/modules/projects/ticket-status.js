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
  running: ["reviewing", "failed", "cancelled", "needs_human_review"],
  reviewing: ["done", "failed", "cancelled", "needs_human_review"],
  done: [],
  failed: ["pending"],
  cancelled: [],
  needs_human_review: ["pending", "cancelled"]
};

export const TICKET_TRANSITIONS = Object.freeze(Object.fromEntries(
  Object.entries(TRANSITIONS).map(([status, next]) => [status, Object.freeze([...next])])
));

export function isTicketStatus(status) {
  return typeof status === "string" && TICKET_STATUSES.includes(status);
}

export function canTransitionTicketStatus(from, to) {
  return isTicketStatus(from) && isTicketStatus(to) && TICKET_TRANSITIONS[from].includes(to);
}

export function assertTicketStatus(status, field = "status") {
  if (!isTicketStatus(status)) throw statusError("STATUS_INVALID", `Invalid ticket ${field}: ${status ?? "<missing>"}.`);
  return status;
}

export function assertTicketStatusTransition(from, to) {
  assertTicketStatus(from, "current status");
  assertTicketStatus(to, "next status");
  if (!canTransitionTicketStatus(from, to)) throw statusError("STATUS_TRANSITION_INVALID", `Invalid ticket status transition: ${from} -> ${to}.`);
  return true;
}

function statusError(code, message) {
  const error = new ConfigurationError(message);
  error.code = code;
  return error;
}

import test from "node:test";
import assert from "node:assert/strict";
import {
  TICKET_STATUSES,
  TICKET_TRANSITIONS,
  assertTicketStatus,
  assertTicketStatusTransition,
  canTransitionTicketStatus,
  isTicketStatus
} from "../../src/modules/projects/ticket-status.js";

test("ticket status enum includes all runtime states", () => {
  assert.deepEqual(TICKET_STATUSES, ["pending", "blocked", "running", "reviewing", "done", "failed", "cancelled", "needs_human_review"]);
  assert.equal(isTicketStatus("needs_human_review"), true);
  assert.equal(isTicketStatus("unknown"), false);
  assert.equal(Object.isFrozen(TICKET_STATUSES), true);
});

test("ticket transition matrix allows retry and unblocking paths", () => {
  assert.equal(canTransitionTicketStatus("pending", "blocked"), true);
  assert.equal(canTransitionTicketStatus("blocked", "pending"), true);
  assert.equal(canTransitionTicketStatus("failed", "pending"), true);
  assert.equal(canTransitionTicketStatus("needs_human_review", "pending"), true);
  assert.equal(canTransitionTicketStatus("reviewing", "done"), true);
  assert.equal(canTransitionTicketStatus("done", "running"), false);
  assert.equal(canTransitionTicketStatus("cancelled", "running"), false);
  assert.deepEqual(TICKET_TRANSITIONS.done, []);
});

test("status assertions return stable error codes", () => {
  assert.equal(assertTicketStatus("running"), "running");
  assert.throws(() => assertTicketStatus("BROKEN"), (error) => error.code === "STATUS_INVALID");
  assert.equal(assertTicketStatusTransition("failed", "pending"), true);
  assert.throws(() => assertTicketStatusTransition("failed", "running"), (error) => error.code === "STATUS_TRANSITION_INVALID");
});

// Verifies the existing owner evidence API exposes automatic blocker proposals without approving incomplete Coder work.
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketHumanReviewService } from "../../src/application/ticket-human-review-service.js";

test("owner evidence includes the prepared blocker proposal but does not enable Human Approve", async () => {
  const recovery = { job_id: "JOB", status: "owner_required", proposal: { title: "Contract decision", options: [{ id: "retain", description: "Preserve compatibility" }], recommended_option_id: "retain" } };
  const service = createTicketHumanReviewService({ projectId: "P",
    roadmaps: { getCurrent: () => ({ sprints: [{ tickets: [{ id: "TASK", project_id: "P" }] }] }), updateTicketStatus: () => assert.fail("Read must not update status") },
    ticketStatusStore: { get: () => ({ status: "needs_human_review", details: {} }), completeByHumanReview: () => assert.fail("Blocker is not Reviewer approval") },
    checkpoints: { load: async () => ({ status: "blocked", blocker_recovery: recovery }), loadReview: async () => null } });
  const result = await service.get({ requestedProjectId: "P", ticketId: "TASK" });
  assert.deepEqual(result.blocker_recovery, recovery);
  assert.equal(result.eligible, false);
  assert.equal(result.approved, false);
});

/** Exposes legacy and modern technical questions through the existing Owner
 * panel without enabling ticket acceptance or changing the parked checkpoint. */
test("Owner evidence delivers the runtime-bound question separately from AM policy options", async () => {
  const recovery = { job_id: "JOB", status: "reconciliation_required", waiting_for: [{ owner: "external", question: "Direct response?" }] };
  const request = { request_id: "Q", job_id: "JOB", execution_id: "E", kind: "information", question: "Direct response?", context: "Exact retained operation and denial" };
  const service = createTicketHumanReviewService({ projectId: "P",
    roadmaps: { getCurrent: () => ({ sprints: [{ tickets: [{ id: "TASK", project_id: "P" }] }] }), updateTicketStatus: () => assert.fail("Read must not write") },
    ticketStatusStore: { get: () => ({ status: "needs_human_review", details: {} }), completeByHumanReview: () => assert.fail("Not acceptance") },
    checkpoints: { load: async () => ({ status: "blocked", blocker_recovery: recovery }), loadReview: async () => null },
    getBlockerOwnerRequest: async (input) => { assert.deepEqual(input, { projectId: "P", ticketId: "TASK" }); return request; } });
  const result = await service.get({ requestedProjectId: "P", ticketId: "TASK" });
  assert.deepEqual(result.blocker_recovery.owner_input_request, request);
  assert.equal(result.blocker_recovery.status, "reconciliation_required");
  assert.equal(result.eligible, false);
  assert.equal(recovery.owner_input_request, undefined);
});

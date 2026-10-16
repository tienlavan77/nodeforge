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

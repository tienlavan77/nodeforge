// Verifies API ticket projections distinguish active Reviewer work from resumable review checkpoints.
import assert from "node:assert/strict";
import test from "node:test";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

for (const [status, resumable] of [["in_progress", false], ["failed", true]]) {
  test(`review checkpoint ${status} projects resumable=${resumable}`, async () => {
    const routes = createForgeV1ConversationRoutes({ listResumableCheckpoints: async () => [{ task_id: "T", phase: "review", status }] });
    const [sprint] = await routes.withCheckpointSummary([{ tickets: [{ id: "T", status: "reviewing" }] }]);
    assert.equal(sprint.tickets[0].checkpoint.resumable, resumable);
    assert.equal(sprint.tickets[0].checkpoint.active_stage, "reviewer");
    assert.equal(sprint.tickets[0].status, "reviewing");
  });
}

test("SDK timeout projects the failure reason and an actionable checkpoint without owner approval", async () => {
  const routes = createForgeV1ConversationRoutes({ listResumableCheckpoints: async () => [{ task_id: "T", status: "failed", phase: "sdk_timeout",
    last_completed_turn: 125, failure: { code: "SDK_REQUEST_TIMEOUT", message: "Codex SDK request timed out for CODER.", resume_allowed: true } }] });
  const [sprint] = await routes.withCheckpointSummary([{ tickets: [{ id: "T", status: "failed" }] }]);
  assert.equal(sprint.tickets[0].checkpoint.resumable, true);
  assert.equal(sprint.tickets[0].checkpoint.last_completed_turn, 125);
  assert.equal(sprint.tickets[0].checkpoint.failure.resume_allowed, true);
  assert.match(sprint.tickets[0].checkpoint.failure.message, /timed out/);
  assert.equal(sprint.tickets[0].checkpoint.blocker_owner_decision, false);
});

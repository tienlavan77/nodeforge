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

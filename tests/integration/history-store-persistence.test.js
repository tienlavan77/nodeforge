import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";

test("persists archived history and reloads it after restart", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-history-"));
  let database = await openIndexDatabase(root);
  try {
    const subscriptions = createSubscriptionRegistry();
    const history = createHistoryStore({ subscriptions, database, clock: () => new Date("2026-08-21T00:00:00Z") });
    subscriptions.publish({ event_type: "workflow.completed", event_id: "EVT-HISTORY-1", project_id: "PROJECT-HISTORY", timestamp: "2026-08-20T00:00:00Z", source: "node", payload: { result: "done" }, metadata: { task_id: "TASK-HISTORY" } });
    assert.equal(history.compact({ projectId: "PROJECT-HISTORY", taskIds: ["TASK-HISTORY"] }).archived, 1);
    await database.close();
    database = await openIndexDatabase(root);
    const reloaded = createHistoryStore({ subscriptions: createSubscriptionRegistry(), database });
    assert.equal(reloaded.getByProject("PROJECT-HISTORY")[0].tier, "warm");
    assert.equal(reloaded.getStats().archived_records, 1);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

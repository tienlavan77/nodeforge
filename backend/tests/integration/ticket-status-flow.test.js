import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";

async function setup(projectId = "PROJECT-FLOW") {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-status-flow-"));
  const database = await createDatabaseService({ dataDir });
  const events = [];
  const store = createTicketStatusStore({ database, projectId, onEvent: (event) => events.push(event), clock: () => new Date("2026-08-31T12:00:00Z") });
  return { database, store, events };
}

test("ticket status completes the full lifecycle without changing roadmap data", async () => {
  const { database, store, events } = await setup();
  store.create("T-DEPENDENCY");
  store.create("T-MAIN", { roadmap_status: "planned" });
  store.updateStatus("T-MAIN", "blocked", { reason: "dependency", blocked_by: ["T-DEPENDENCY"] }, { expectedCurrentStatus: "pending" });
  assert.equal(store.dependenciesReady("T-MAIN", ["T-DEPENDENCY"]).ready, false);
  store.updateStatus("T-DEPENDENCY", "running");
  store.updateStatus("T-DEPENDENCY", "reviewing");
  store.updateStatus("T-DEPENDENCY", "done");
  store.updateStatus("T-MAIN", "pending", { reason: "dependency_recheck" }, { expectedCurrentStatus: "blocked" });
  assert.equal(store.dependenciesReady("T-MAIN", ["T-DEPENDENCY"]).ready, true);
  store.updateStatus("T-MAIN", "running");
  store.updateStatus("T-MAIN", "reviewing");
  store.updateStatus("T-MAIN", "done", { commit: "abc123" });
  assert.equal(store.getStatus("T-MAIN"), "done");
  assert.equal(store.get("T-MAIN").details.roadmap_status, undefined);
  assert.equal(store.getHistory("T-MAIN").length, 5);
  assert.equal(events.filter(({ type }) => type === "ticket.status_change").length, 8);
  await database.close();
});

test("failed and human-review tickets retry through pending", async () => {
  const { database, store } = await setup("PROJECT-RETRY");
  store.create("T-RETRY");
  store.updateStatus("T-RETRY", "running");
  store.updateStatus("T-RETRY", "failed", { error: "builder timeout" });
  assert.equal(store.retry("T-RETRY").status, "pending");
  store.updateStatus("T-RETRY", "running");
  store.updateStatus("T-RETRY", "reviewing");
  store.updateStatus("T-RETRY", "needs_human_review", { reason: "round_limit" });
  assert.equal(store.retry("T-RETRY").status, "pending");
  await database.close();
});

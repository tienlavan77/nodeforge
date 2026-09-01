import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";

async function fixture(projectId = "PROJECT-1") {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-status-"));
  const database = await createDatabaseService({ dataDir });
  const events = [];
  const store = createTicketStatusStore({ database, projectId, onEvent: (event) => events.push(event), clock: () => new Date("2026-08-30T12:00:00Z") });
  return { database, store, events };
}

test("Ticket Status Store persists status/history and enforces CAS transitions", async () => {
  const { database, store, events } = await fixture();
  store.create("T-1");
  assert.equal(store.getStatus("T-1"), "pending");
  const running = store.updateStatus("T-1", "running", { reason: "dispatch" }, { expectedCurrentStatus: "pending" });
  assert.equal(running.version, 1);
  assert.equal(store.getHistory("T-1").length, 1);
  assert.equal(events[0].type, "ticket.status_change");
  assert.throws(() => store.updateStatus("T-1", "done", {}, { expectedCurrentStatus: "pending" }), (error) => error.code === "STATUS_CONFLICT");
  await database.close();
});

test("Ticket Status Store checks dependencies and retries failed tickets", async () => {
  const { database, store } = await fixture();
  store.create("T-DEP");
  store.create("T-MAIN");
  store.updateStatus("T-DEP", "running");
  store.updateStatus("T-DEP", "failed");
  assert.deepEqual(store.dependenciesReady("T-MAIN", ["T-DEP", "MISSING"]), { ready: false, blocked_by: [{ id: "T-DEP", status: "failed" }, { id: "MISSING", status: "not_found" }] });
  const retry = store.retry("T-DEP");
  assert.equal(retry.status, "pending");
  await database.close();
});

test("Ticket Status Store isolates projects", async () => {
  const first = await fixture("PROJECT-A");
  const second = await fixture("PROJECT-B");
  first.store.create("T-1");
  assert.equal(second.store.get("T-1"), undefined);
  await first.database.close(); await second.database.close();
});


test("Ticket Status Store publishes only committed transitions", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "forge-status-events-"));
  const database = await createDatabaseService({ dataDir });
  const published = [];
  const store = createTicketStatusStore({ database, projectId: "PROJECT-EVENT", publisher: { publish: (event) => published.push(event) } });
  store.create("T-EVENT");
  store.updateStatus("T-EVENT", "blocked", { reason: "dependency" }, { expectedCurrentStatus: "pending" });
  assert.deepEqual(published.map(({ type }) => type), ["ticket.status_change", "ticket.dependency_blocked"]);
  assert.equal(published[0].payload.to, "blocked");
  assert.throws(() => store.updateStatus("T-EVENT", "done"), (error) => error.code === "STATUS_TRANSITION_INVALID");
  assert.equal(published.length, 2);
  await database.close();
});

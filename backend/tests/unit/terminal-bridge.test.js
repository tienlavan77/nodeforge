import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTerminalBridge } from "../../src/modules/supervisor/terminal-bridge.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";

function baseEvent(overrides = {}) {
  return {
    event_id: `EVT-${Math.random().toString(36).slice(2)}`,
    type: "task.completed",
    task_id: "TICKET-1",
    supervisor_id: "SUP-1",
    request_id: "REQ-1",
    correlation_id: "CORR-1",
    attempt: 1,
    payload: {},
    ...overrides
  };
}

function createMockBus() {
  const handlers = new Map();
  return {
    subscribe(supervisorId, handler) {
      const list = handlers.get(supervisorId) ?? [];
      list.push(handler);
      handlers.set(supervisorId, list);
      return () => {
        handlers.set(supervisorId, (handlers.get(supervisorId) ?? []).filter((item) => item !== handler));
      };
    },
    async publish(event) {
      for (const handler of handlers.get(event.supervisor_id) ?? []) await handler(event);
      for (const handler of handlers.get("*") ?? []) await handler(event);
    }
  };
}

function createMockRoadmaps() {
  const updates = [];
  return {
    updates,
    async updateTicketStatus(update) { updates.push(update); return { ok: true }; }
  };
}

function createMockSummaries() {
  const recorded = [];
  return {
    recorded,
    record(taskId, input) { recorded.push({ taskId, ...input }); return { task_id: taskId, facts: input.facts ?? [] }; }
  };
}

function createMockMemory() {
  const built = [];
  return {
    built,
    build(projectId) { built.push(projectId); return { facts: [] }; }
  };
}

describe("Terminal Bridge", () => {
  let dataDir;
  let bus;
  let ticketStatusStore;
  let roadmaps;
  let taskSummaries;
  let projectMemory;
  let logs;
  let bridge;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "terminal-bridge-"));
    const database = await createDatabaseService({ dataDir });
    ticketStatusStore = createTicketStatusStore({ database, projectId: "PROJECT-NODEFORGE" });
    bus = createMockBus();
    roadmaps = createMockRoadmaps();
    taskSummaries = createMockSummaries();
    projectMemory = createMockMemory();
    logs = [];
    ticketStatusStore.create("TICKET-1");
  });

  function startBridge() {
    bridge = createTerminalBridge({
      eventBus: bus,
      ticketStatusStore,
      roadmaps,
      projectId: "PROJECT-NODEFORGE",
      taskSummaries,
      projectMemory,
      logger: (entry) => logs.push(entry)
    });
  }

  test("maps task.completed to done and syncs roadmap", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    await bus.publish(baseEvent());
    assert.equal(ticketStatusStore.get("TICKET-1").status, "done");
    assert.equal(roadmaps.updates.length, 1);
    assert.equal(roadmaps.updates[0].status, "done");
    assert.equal(roadmaps.updates[0].projectId, "PROJECT-NODEFORGE");
    const synced = logs.find((log) => log.event_name === "terminal_bridge.status_synced");
    assert.ok(synced, "expected terminal_bridge.status_synced log");
  });

  test("maps task.failed to failed with error details", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    await bus.publish(baseEvent({ type: "task.failed", payload: { error: "agent timeout" } }));
    assert.equal(ticketStatusStore.get("TICKET-1").status, "failed");
    assert.equal(roadmaps.updates[0].status, "failed");
    assert.equal(roadmaps.updates[0].error, "agent timeout");
  });

  test("maps needs_human_review event", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    await bus.publish(baseEvent({ type: "task.needs_human_review", payload: { error: { message: "checksum mismatch" } } }));
    assert.equal(ticketStatusStore.get("TICKET-1").status, "needs_human_review");
    assert.equal(roadmaps.updates[0].error, "checksum mismatch");
  });

  test("is idempotent for duplicate events", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    const event = baseEvent();
    await bus.publish(event);
    await bus.publish({ ...event });
    assert.equal(roadmaps.updates.length, 1);
    const synced = logs.filter((log) => log.event_name === "terminal_bridge.status_synced");
    assert.equal(synced.length, 1);
  });

  test("skips terminal events for unknown tickets", async () => {
    startBridge();
    await bus.publish(baseEvent({ task_id: "TICKET-MISSING" }));
    assert.equal(roadmaps.updates.length, 0);
    assert.ok(logs.find((log) => log.event_name === "terminal_bridge.skipped"));
  });

  test("ignores events already in a terminal state", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "cancelled", { reason: "human" });
    await bus.publish(baseEvent());
    assert.equal(ticketStatusStore.get("TICKET-1").status, "cancelled");
    assert.equal(roadmaps.updates.length, 0);
  });

  test("records memory facts from task.completed summary", async () => {
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    await bus.publish(baseEvent({
      payload: { summary: "Decision: use optimistic concurrency.\nImplemented the feature.\nAlways validate checksums before apply." }
    }));
    assert.equal(taskSummaries.recorded.length, 1);
    assert.deepEqual(taskSummaries.recorded[0].facts, [
      "Decision: use optimistic concurrency.",
      "Always validate checksums before apply."
    ]);
    assert.deepEqual(projectMemory.built, ["PROJECT-NODEFORGE"]);
    assert.ok(logs.find((log) => log.event_name === "terminal_bridge.memory_recorded"));
  });

  test("memory failure does not fail the bridge", async () => {
    projectMemory.build = () => { throw new Error("memory boom"); };
    startBridge();
    ticketStatusStore.updateStatus("TICKET-1", "running", { reason: "dispatch" });
    await bus.publish(baseEvent({ payload: { summary: "Decision: keep going." } }));
    assert.equal(ticketStatusStore.get("TICKET-1").status, "done");
    assert.ok(logs.find((log) => log.event_name === "terminal_bridge.memory_failed"));
  });

  test("close() unsubscribes from the bus", async () => {
    startBridge();
    bridge.close();
    await bus.publish(baseEvent());
    assert.equal(roadmaps.updates.length, 0);
  });

  test("requires its dependencies", () => {
    assert.throws(() => createTerminalBridge({}), /event bus/);
    assert.throws(() => createTerminalBridge({ eventBus: createMockBus() }), /Ticket Status Store/);
    assert.throws(() => createTerminalBridge({ eventBus: createMockBus(), ticketStatusStore, roadmaps }), /project_id/);
  });
});

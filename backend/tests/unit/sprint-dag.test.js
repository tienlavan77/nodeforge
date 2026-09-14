import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { createSprintDagRunner, topologicalTicketLevels } from "../../src/modules/supervisor/sprint-dag.js";
import { ConfigurationError } from "../../src/shared/errors.js";

function tickets(raw) { return raw.map(([id, ...dependencies]) => ({ id, dependencies })); }

function stubStatusStore(statuses = {}) {
  const calls = [];
  return Object.freeze({
    calls,
    getStatus: (ticketId) => statuses[ticketId],
    dependenciesReady: (ticketId, ids = []) => {
      calls.push({ ticketId, ids });
      const blocked_by = ids.map((id) => ({ id, status: statuses[id] ?? "not_found" })).filter(({ status }) => status !== "done");
      return { ready: blocked_by.length === 0, blocked_by };
    }
  });
}

function stubBus({ publish } = {}) {
  const handlers = new Map();
  return Object.freeze({
    subscribe: (supervisorId, handler) => {
      const list = handlers.get(supervisorId) ?? [];
      list.push(handler);
      handlers.set(supervisorId, list);
      return () => { const cur = handlers.get(supervisorId) ?? []; handlers.set(supervisorId, cur.filter((item) => item !== handler)); };
    },
    handlers,
    publish: publish ?? (async () => {})
  });
}

describe("sprint dag runner", () => {
  it("computes topological levels: linear A->B->C", () => {
    const input = tickets([["A"], ["B", "A"], ["C", "B"]]);
    const levels = topologicalTicketLevels(input);
    assert.deepEqual(levels.map((level) => level.map((ticket) => ticket.id)), [["A"], ["B"], ["C"]]);
  });

  it("groups independent tickets on one level", () => {
    const input = tickets([["B"], ["A"], ["C"]]);
    const levels = topologicalTicketLevels(input);
    // single root level, sorted lexicographically
    assert.deepEqual(levels.map((level) => level.map((ticket) => ticket.id)), [["A", "B", "C"]]);
  });

  it("splits dependency DAG into multiple levels", () => {
    // A,B no deps; C depends on A+B; D depends on C
    const input = tickets([["C", "A", "B"], ["D", "C"], ["A"], ["B"]]);
    const levels = topologicalTicketLevels(input);
    assert.deepEqual(levels.map((level) => level.map((ticket) => ticket.id)), [["A", "B"], ["C"], ["D"]]);
  });

  it("throws SPRINT_DEPENDENCY_CYCLE for cycles", () => {
    const input = tickets([["A", "B"], ["B", "A"]]);
    assert.throws(() => topologicalTicketLevels(input), (error) => error instanceof ConfigurationError && error.code === "SPRINT_DEPENDENCY_CYCLE");
  });

  it("ignores dependencies that are not inside the sprint", () => {
    const input = tickets([["B", "OUTSIDE"], ["A"]]);
    const levels = topologicalTicketLevels(input);
    assert.deepEqual(levels.map((level) => level.map((ticket) => ticket.id)), [["A", "B"]]);
  });

  it("waits on dependencies before dispatching a dependent ticket (event-driven)", async () => {
    const levels = topologicalTicketLevels(tickets([["A"], ["B", "A"]]));
    const statuses = { A: "running", B: "pending" };
    const store = stubStatusStore(statuses);
    const bus = stubBus();
    const order = [];
    const runner = createSprintDagRunner({
      ticketStatusStore: store,
      eventBus: bus,
      dispatchTask: async ({ ticket }) => { order.push(ticket.id); return { ticket_id: ticket.id }; }
    });
    const execution = runner.runSprintLevels({ projectId: "PROJECT-NODEFORGE", sprintId: "S-1", levels });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    await tick();
    // A is dispatched; B must still be blocked on A's terminal event.
    assert.deepEqual(order, ["A"]);
    fireTerminal(bus, statuses, "A");
    await tick();
    assert.deepEqual(order, ["A", "B"]);
    assert.ok(store.calls.some(({ ticketId, ids }) => ticketId === "B" && ids.includes("A")));
    fireTerminal(bus, statuses, "B");
    await execution;
  });

  it("fails when a predecessor ends as failed", async () => {
    const input = tickets([["A"], ["B", "A"]]);
    const levels = topologicalTicketLevels(input);
    const statuses = { A: "failed", B: "pending" };
    const store = stubStatusStore(statuses);
    const bus = stubBus();
    const runner = createSprintDagRunner({ ticketStatusStore: store, eventBus: bus, dispatchTask: async () => ({}) });
    await assert.rejects(() => runner.runSprintLevels({ projectId: "P", sprintId: "S", levels }), (error) => error.code === "SPRINT_DEPENDENCY_FAILED");
  });

  it("dispatches dependents as soon as their dependency is already done", async () => {
    const levels = topologicalTicketLevels(tickets([["A"], ["B", "A"]]));
    const statuses = { A: "done", B: "pending" };
    const store = stubStatusStore(statuses);
    const bus = stubBus();
    const order = [];
    const runner = createSprintDagRunner({
      ticketStatusStore: store,
      eventBus: bus,
      dispatchTask: async ({ ticket }) => { order.push(ticket.id); statuses[ticket.id] = "done"; return {}; }
    });
    await runner.runSprintLevels({ projectId: "P", sprintId: "S2", levels });
    assert.deepEqual(order, ["A", "B"]);
  });
});

function fireTerminal(bus, statuses, ticketId) {
  statuses[ticketId] = "done";
  for (const handler of bus.handlers.get("*") ?? []) handler({ type: "task.completed", task_id: ticketId });
}

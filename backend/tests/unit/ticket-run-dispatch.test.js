// Verifies shared ticket RUN persists lifecycle state and preserves gates during Sprint execution.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createTerminalBridge } from "../../src/modules/supervisor/terminal-bridge.js";
import { createSprintDagRunner, topologicalTicketLevels } from "../../src/modules/supervisor/sprint-dag.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

// Builds real status persistence with bounded fake agents for ticket and Sprint regression cases.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ticket-run-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const store = createTicketStatusStore({ database, projectId: "PROJECT-A" });
  const handlers = new Set();
  const bus = { subscribe: (_scope, fn) => { handlers.add(fn); return () => handlers.delete(fn); }, publish: async (event) => { await Promise.all([...handlers].map((fn) => fn(event))); } };
  const tickets = [{ id: "TICKET-A", sprint_id: "SPRINT-A", project_id: "PROJECT-A", title: "First", objective: "Fix first", dependencies: [], acceptance_criteria: ["Works"] }, { id: "TICKET-B", sprint_id: "SPRINT-A", project_id: "PROJECT-A", title: "Second", objective: "Fix second", dependencies: ["TICKET-A"], acceptance_criteria: ["Works"] }];
  const plan = { content: { tickets: tickets.map((ticket) => ticket.id), ticket_specs: structuredClone(tickets) } };
  const bridge = createTerminalBridge({ eventBus: bus, ticketStatusStore: store, projectId: "PROJECT-A", roadmaps: { updateTicketStatus: ({ ticketId, status }) => { tickets.find((ticket) => ticket.id === ticketId).status = status; } } });
  const calls = [];
  const state = { coder: null, review: null, execute: async ({ ticket }) => { await bus.publish({ type: "task.completed", task_id: ticket.id }); return { status: "completed" }; } };
  const checkpointActions = [];
  const dispatch = createTicketRunDispatch({
    disposition: { get: async () => null },
    intake: { open: async ({ ticketId }) => {
      const ticket = tickets.find((item) => item.id === ticketId);
      if (!store.dependenciesReady(ticketId, ticket.dependencies).ready) throw Object.assign(new Error("Dependencies unfinished"), { code: "SPRINT_DEPENDENCIES_NOT_READY" });
      return { ticket };
    } },
    sprintRegistry: { get: () => ({ status: "ready" }), assertReady: async () => ({ plan }) },
    ticketStatusStore: store,
    checkpoints: { load: async () => state.coder, loadReview: async () => state.review, clear: async () => checkpointActions.push("clear") },
    protocolStorage: { clearTask: async () => checkpointActions.push("protocol-clear") },
    conversationStateStore: { clear: async () => checkpointActions.push("conversation-clear") },
    dispatchTask: async (request) => { calls.push(request); assert.equal(store.getStatus(request.ticket.id), "running"); return state.execute(request); }
  });
  return { store, bus, tickets, plan, state, calls, checkpointActions, dispatch, close: async () => { bridge.close(); await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Exercises untracked tickets through terminal completion and dependent Sprint dispatch.
test("Sprint RUN creates missing ticket statuses and opens the next dependency level", async () => {
  const f = await fixture();
  try {
    const runner = createSprintDagRunner({ ticketStatusStore: f.store, eventBus: f.bus, dispatchTask: ({ ticket }) => f.dispatch({ projectId: ticket.project_id, ticketId: ticket.id }) });
    await runner.runSprintLevels({ projectId: "PROJECT-A", sprintId: "SPRINT-A", levels: topologicalTicketLevels(f.tickets) });
    assert.deepEqual(f.calls.map((call) => call.ticket.id), ["TICKET-A", "TICKET-B"]);
    assert.equal(f.store.getStatus("TICKET-A"), "done");
    assert.equal(f.store.getStatus("TICKET-B"), "done");
    await runner.runSprintLevels({ projectId: "PROJECT-A", sprintId: "SPRINT-A", levels: topologicalTicketLevels(f.tickets) });
    assert.equal(f.calls.length, 2);
  } finally { await f.close(); }
});

// Keeps checkpoint and immutable contract failures from dispatching an agent or changing status.
test("shared RUN retains blocked checkpoints and rejects invalid A5 contracts", async () => {
  const f = await fixture();
  try {
    f.state.coder = { status: "blocked" };
    await assert.rejects(f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { code: "TICKET_APPROVAL_REQUIRED" });
    assert.deepEqual(f.checkpointActions, []);
    f.state.coder = null;
    f.tickets[0].rollout_package = "A5";
    await assert.rejects(f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { code: "A5_EXECUTION_CONTRACT_REQUIRED" });
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.getStatus("TICKET-A"), undefined);
    delete f.tickets[0].rollout_package;
    f.store.create("TICKET-A");
    f.store.updateStatus("TICKET-A", "blocked");
    await assert.rejects(f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { code: "TICKET_APPROVAL_REQUIRED" });
    assert.deepEqual(f.checkpointActions, []);
  } finally { await f.close(); }
});

// Resumes independent review without clearing completed Coder evidence.
test("shared RUN forwards completed Coder checkpoint to Reviewer resume", async () => {
  const f = await fixture();
  try {
    f.state.coder = { status: "completed", agent_id: "CODER", provider: "codex", last_completed_turn: 4 };
    f.state.review = { status: "failed", review_attempt: 1, base_commit: "base" };
    const result = await f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" });
    assert.equal(f.calls[0].review_resume.agent_id, "CODER");
    assert.equal(result.resumed, true);
    assert.deepEqual(f.checkpointActions, []);
  } finally { await f.close(); }
});

// Records a rejected dispatch so UI and dependencies do not stay running forever.
test("dispatch failures persist failed state before surfacing the error", async () => {
  const f = await fixture();
  try {
    f.state.execute = async () => { throw Object.assign(new Error("No ready coder"), { code: "AGENT_NOT_AVAILABLE" }); };
    await assert.rejects(f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { code: "AGENT_NOT_AVAILABLE" });
    assert.equal(f.store.getStatus("TICKET-A"), "failed");
  } finally { await f.close(); }
});

// Stops a live ticket run through its abort signal and leaves a retryable failed status.
test("Stop aborts only the active ticket and preserves its retry path", async () => {
  const f = await fixture();
  try {
    f.state.execute = ({ abortSignal }) => new Promise((resolve, reject) => {
      abortSignal.addEventListener("abort", () => reject(abortSignal.reason), { once: true });
    });
    const running = f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" });
    while (f.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.store.getStatus("TICKET-A"), "running");
    assert.deepEqual(f.dispatch.stop({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { ticket_id: "TICKET-A", status: "stopping" });
    await assert.rejects(running, { code: "TICKET_STOPPED" });
    assert.equal(f.store.getStatus("TICKET-A"), "failed");
    assert.deepEqual(f.checkpointActions, ["clear", "protocol-clear", "conversation-clear"]);
    assert.throws(() => f.dispatch.stop({ projectId: "PROJECT-A", ticketId: "TICKET-A" }), { code: "TICKET_NOT_RUNNING" });
  } finally { await f.close(); }
});

// Prevents duplicate RUN clicks from clearing checkpoints or dispatching twice.
test("concurrent ticket RUN reuses the active dispatch", async () => {
  const f = await fixture();
  let finish;
  try {
    let started;
    const ready = new Promise((resolve) => { started = resolve; });
    f.state.execute = async ({ ticket }) => { started(); await new Promise((resolve) => { finish = resolve; }); await f.bus.publish({ type: "task.completed", task_id: ticket.id }); return { status: "completed" }; };
    const first = f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" });
    await ready;
    assert.equal((await f.dispatch({ projectId: "PROJECT-A", ticketId: "TICKET-A" })).status, "already_running");
    assert.equal(f.calls.length, 1);
    finish();
    await first;
  } finally { finish?.(); await f.close(); }
});

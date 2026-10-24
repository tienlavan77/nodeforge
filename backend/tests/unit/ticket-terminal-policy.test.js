// Verifies retry-ready ticket status and fenced launch reconciliation using real project-local SQLite records.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createTerminalBridge } from "../../src/modules/supervisor/terminal-bridge.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";

const BASIS = { project_id: "PROJECT-A", sprint_id: "SPRINT-A", plan_id: "PLAN-A", plan_revision: 1, plan_path: "plans/1.json", plan_sha256: "a".repeat(64), version: 1 };

// Runs serial lifecycle SQL tests through Python SQLite without requiring native SQLite in the CLI's Node version.
async function fixture(context) {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".forge/scratch/ticket-terminal-policy-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "index.db");
  // Reads or commits one isolated SQLite statement; transaction scheduling is not under test in this adapter.
  const query = (sql, parameters = [], write = false) => JSON.parse(execFileSync("python3", ["-c", 'import sqlite3,json,sys; request=json.loads(sys.stdin.read()); connection=sqlite3.connect(sys.argv[1]); connection.row_factory=sqlite3.Row; cursor=connection.execute(request["sql"],request["parameters"]); result={"changes":cursor.rowcount} if request["write"] else [dict(row) for row in cursor]; connection.commit(); print(json.dumps(result)); connection.close()', path], { input: JSON.stringify({ sql, parameters, write }), encoding: "utf8" }));
  const database = { all: (sql, parameters) => query(sql, parameters), run: (sql, parameters) => query(sql, parameters, true), transaction: (action) => action() };
  const store = createTicketStatusStore({ database, projectId: "PROJECT-A", retryFailedTickets: true });
  store.create("TICKET-A");
  const running = store.beginExecution("TICKET-A", { executionId: "RUN-A", basis: BASIS, expectedVersion: 0, dependencyExpectations: [] });
  const launch = { executionId: "RUN-A", basis: BASIS, requestId: "REQ-A", jobId: "JOB-A", supervisorId: "SUP-A", agentId: "CODER-A", claimId: "CLAIM-A", validate: () => {} };
  return { store, running, launch };
}

// Keeps the failed attempt visible in history while exposing pending as the current retry-ready status.
test("current-stage failure returns pending and retains original failure evidence", async (context) => {
  const { store } = await fixture(context);
  const result = store.updateStatus("TICKET-A", "failed", { error: "Verification failed", reason: "VERIFY_FAILED" });
  assert.equal(result.status, "pending");
  assert.equal(result.error, null);
  assert.equal(result.details.last_failure.error, "Verification failed");
  assert.deepEqual(store.getHistory("TICKET-A").map((row) => row.to_status), ["running", "failed", "pending"]);
  assert.equal(store.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: result.version }).status, "running");
});

// Reconciles only the settled launch, retains its receipt and permits the next explicit RUN.
test("settled launch is released before failed ticket becomes retry ready", async (context) => {
  const { store, launch } = await fixture(context);
  store.claimExecutionLaunch("TICKET-A", launch);
  const identity = { executionId: "RUN-A", requestId: "REQ-A", jobId: "JOB-A", disposition: "executor_failed" };
  const settled = store.reconcileExecutionLaunch("TICKET-A", identity);
  assert.equal(settled.details.launch_claim, null);
  assert.equal(settled.details.launch_reconciliation.receipt.claim_id, "CLAIM-A");
  assert.deepEqual(store.reconcileExecutionLaunch("TICKET-A", identity), settled);
  assert.throws(() => store.reconcileExecutionLaunch("TICKET-A", { ...identity, jobId: "JOB-OTHER" }), { code: "STATUS_CONFLICT" });
  const ready = store.updateStatus("TICKET-A", "failed", { error: "SDK stopped" });
  assert.equal(ready.status, "pending");
  assert.equal(store.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: ready.version }).status, "running");
});

// Rejects stale failure cleanup instead of freeing the active launch belonging to another request.
test("stale reconciliation cannot release the current owner", async (context) => {
  const { store, launch } = await fixture(context);
  const receipt = store.claimExecutionLaunch("TICKET-A", launch);
  assert.throws(() => store.reconcileExecutionLaunch("TICKET-A", { executionId: "RUN-OLD", requestId: "REQ-A", jobId: "JOB-A", disposition: "executor_failed" }), { code: "STATUS_CONFLICT" });
  assert.deepEqual(store.get("TICKET-A").details.launch_claim, receipt);
});

// Does not make a crashed, unobserved executor retryable while it might still be mutating source.
test("unknown live launch remains fenced rather than inviting overlapping RUN", async (context) => {
  const { store, launch } = await fixture(context);
  store.claimExecutionLaunch("TICKET-A", launch);
  const result = store.updateStatus("TICKET-A", "failed", { error: "Provider outcome unknown" });
  assert.equal(result.status, "failed");
  assert.throws(() => store.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: result.version }), { code: "TICKET_EXECUTION_RECONCILIATION_REQUIRED" });
});

// Makes an already failed ticket retry-ready only after its stopped executor has a reconciled disposition.
test("late executor reconciliation moves an already failed ticket back to pending", async (context) => {
  const { store, launch } = await fixture(context);
  store.claimExecutionLaunch("TICKET-A", launch);
  store.updateStatus("TICKET-A", "failed", { error: "Execution stopped" });
  const ready = store.reconcileExecutionLaunch("TICKET-A", { executionId: "RUN-A", requestId: "REQ-A", jobId: "JOB-A", disposition: "executor_failed" });
  assert.equal(ready.status, "pending");
  assert.equal(ready.details.last_failure.error, "Execution stopped");
  assert.equal(ready.details.launch_claim, undefined);
});

// Releases a successfully settled executor without changing the ticket's completion criteria.
test("success reconciliation preserves running until verified completion and then done", async (context) => {
  const { store, launch } = await fixture(context);
  store.claimExecutionLaunch("TICKET-A", launch);
  assert.equal(store.reconcileExecutionLaunch("TICKET-A", { executionId: "RUN-A", requestId: "REQ-A", jobId: "JOB-A", disposition: "executor_returned" }).status, "running");
  assert.equal(store.updateStatus("TICKET-A", "done", { reason: "coder_verified" }).status, "done");
  assert.equal(store.get("TICKET-A").details.launch_claim, undefined);
});

// Exercises the actual integration catch path, durable queue and terminal bridge against persisted status records.
for (const outcome of ["sdk_failure", "completion_failure", "completed"]) {
test(`integration ${outcome} clears ended launch, agent and file claims`, async (context) => {
  const { store } = await fixture(context);
  const actions = [];
  const jobs = new Map();
  const queue = createDurableQueue({ name: "sender.handoff", store: { list: async () => [...jobs.values()], save: async (_name, job) => jobs.set(job.id, job) } });
  const handlers = [];
  const bus = { subscribe: (_name, handler) => { handlers.push(handler); return () => {}; }, publish: async (event) => { for (const handler of handlers) await handler(event); } };
  const bridge = createTerminalBridge({ eventBus: bus, ticketStatusStore: store, projectId: "PROJECT-A", roadmaps: { updateTicketStatus: () => {} } });
  context.after(() => bridge.close());
  const profile = { agent_id: "CODER-A", agent_name: "Coder A", role: "coder", provider: "codex", enabled: true, status: "ready" };
  let claim = null;
  let checkpoint = { task_id: "TICKET-A", status: "in_progress", last_completed_turn: 37, changed_paths: ["backend/source.js"] };
  const workspace = { projectRoot: process.cwd(), toolRegistry: {}, changeLedger: { resume: async () => actions.push("resume_files"), release: async () => actions.push("release_files") } };
  const integration = createNodeforgeTaskIntegration({ supervisorManager: { startTask: async () => {} }, eventBus: bus, ticketStatusStore: store,
    sprintRegistry: { get: () => ({ ...BASIS, status: "ready" }) }, projectRoot: process.cwd(), handoffQueue: queue,
    agentResolver: { resolveAvailable: () => profile, list: () => [profile] },
    agentOccupancy: { getByTask: () => claim, claim: async () => { claim = { claim_id: "CLAIM-A", agent_id: "CODER-A" }; return claim; }, release: async () => { claim = null; actions.push("release_agent"); } },
    checkpointStore: { load: async () => checkpoint, save: async (value) => { checkpoint = value; }, complete: async () => { checkpoint = { ...checkpoint, status: "completed" }; } },
    resolveTicketWorkspace: async () => workspace,
    runtimeGovernance: { createExecutionContext: (options) => options },
    codexSdkGateway: { execute: async ({ onEvent }) => {
      actions.push("executor_ended");
      if (outcome === "sdk_failure") throw Object.assign(new Error("SDK process exited"), { code: "AGENT_PROCESS_EXITED" });
      for (const tool of ["write_diff", "commit_changes", "report_done"]) await onEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", tool, status: "success" } });
      let state = { state: "verified", version: 1 };
      workspace.executionContexts = { load: async () => state, update: async (_task, _version, patch) => { state = { ...state, ...patch, version: state.version + 1 }; } };
      workspace.testService = { assertPassedArtifact: async () => { if (outcome === "completion_failure") throw Object.assign(new Error("Artifact failed"), { code: "VERIFY_FAILED" }); return { artifact_id: "ARTIFACT-A", commit_sha: "a".repeat(40) }; } };
      workspace.reportService = { assertCoderReport: async () => {}, completeCoderReport: async () => {} };
      workspace.integrate = async () => actions.push("integrate");
      return { text: "Completed fixture" };
    } }
  });
  const run = integration.submitTicket({ ticket: { id: "TICKET-A", project_id: "PROJECT-A", sprint_id: "SPRINT-A", dependencies: [], required_role: "coder" }, project_id: "PROJECT-A", request_id: "REQ-A",
    payload: { execution_id: "RUN-A", sprint_basis: BASIS, dependency_expectations: [], resume_from: checkpoint } });
  if (outcome === "completed") assert.equal((await run).status, "completed");
  else await assert.rejects(run, { code: outcome === "sdk_failure" ? "AGENT_PROCESS_EXITED" : "VERIFY_FAILED" });
  assert.equal(claim, null);
  assert.equal(store.get("TICKET-A").status, outcome === "completed" ? "done" : "pending");
  assert.equal(store.get("TICKET-A").details.launch_claim, undefined);
  assert.ok(actions.indexOf("release_files") > actions.indexOf("executor_ended"));
  assert.equal(checkpoint.status, outcome === "sdk_failure" ? "failed" : "completed");
  assert.equal(checkpoint.last_completed_turn, 37);
  assert.equal([...jobs.values()][0].status, outcome === "sdk_failure" ? "dead_letter" : "completed");
  assert.equal(actions.filter((action) => action === "release_files").length, 1);
  if (outcome !== "completed") assert.equal(store.beginExecution("TICKET-A", { executionId: "RUN-B", basis: BASIS, expectedVersion: store.get("TICKET-A").version }).status, "running");
});
}

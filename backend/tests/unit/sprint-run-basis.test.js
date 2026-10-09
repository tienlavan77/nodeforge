// Verifies approved Sprint RUN admission and late callbacks preserve the observed SQLite execution basis.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintRunDispatch } from "../../src/application/sprint-run-dispatch.js";
import { createApprovedTicketDispatch } from "../../src/application/approved-ticket-dispatch.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createSprintDagRunner } from "../../src/modules/supervisor/sprint-dag.js";

const PROJECT = "PROJECT-A";
const SPRINT = "SPRINT-A";
const TICKET = { id: "TICKET-A", project_id: PROJECT, sprint_id: SPRINT, title: "Protect RUN", objective: "Preserve approved intent", dependencies: [], acceptance_criteria: ["Stale callbacks cannot overwrite current RUN"] };
const CONTENT = { objective: TICKET.objective, outcome: "Fence Sprint RUN", in_scope: "RUN basis", out_of_scope: "Migration", approach: "Version fencing", components: ["Registry"], tickets: [TICKET.id], ticket_specs: [TICKET], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [TICKET.id], acceptance_criteria: TICKET.acceptance_criteria };

// Controls execution boundaries without timing sleeps or synthetic approval responses.
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Creates real immutable files, owner approval, and durable SQLite scheduling records.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "sprint-run-basis-"));
  const options = { dataDir: join(root, "runtime"), runtimeDir: "." };
  const database = await createDatabaseService(options);
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const plan = await plans.createRevision({ planId: "PLAN-A", sprintId: SPRINT, expectedRevision: 0, content: CONTENT });
  await plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  await registry.register({ sprintId: SPRINT, position: 0, planId: plan.plan_id, revision: 1 });
  await registry.setStatus({ sprintId: SPRINT, status: "ready" });
  return { root, options, database, fileService, plans, registry, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Observes terminal persistence and stale callback logging while holding the actual DAG execution open.
function controlledRun(f) {
  const entered = deferred();
  const execution = deferred();
  const settled = deferred();
  const logs = [];
  const registry = { ...f.registry, setStatus: async (input) => {
    const result = await f.registry.setStatus(input);
    if (["done", "failed"].includes(input.status)) settled.resolve();
    return result;
  } };
  const dispatch = createSprintRunDispatch({ projectId: PROJECT, sprintRegistry: registry, sprintDagRunner: { runSprintLevels: (input) => { entered.resolve(input); return execution.promise; } }, logEvent: (entry) => { logs.push(entry); if (entry.event_name === "sprint.registry_update_failed") settled.resolve(); } });
  return { dispatch, entered, execution, settled, logs };
}

test("Sprint RUN uses immutable specs and one captured version for its terminal commit", { timeout: 5000 }, async () => {
  const f = await fixture();
  const run = controlledRun(f);
  try {
    const observed = f.registry.get(SPRINT);
    const result = await run.dispatch({ projectId: PROJECT, sprintId: SPRINT });
    const input = await run.entered.promise;
    assert.equal(result.status, "accepted");
    assert.deepEqual(input.levels, [[TICKET]]);
    assert.equal(input.sprintBasis.version, observed.version + 1);
    assert.equal(input.sprintBasis.plan_sha256, observed.plan_sha256);
    run.execution.resolve();
    await run.settled.promise;
    assert.equal(f.registry.get(SPRINT).status, "done");
    assert.equal(f.registry.get(SPRINT).version, input.sprintBasis.version + 1);
  } finally { run.execution.resolve(); await f.close(); }
});

test("parallel Sprint RUN admits one winner without an in-memory running Set", { timeout: 5000 }, async () => {
  const f = await fixture();
  const run = controlledRun(f);
  try {
    const results = await Promise.allSettled([run.dispatch({ projectId: PROJECT, sprintId: SPRINT }), run.dispatch({ projectId: PROJECT, sprintId: SPRINT })]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.find((result) => result.status === "rejected").reason.code, "SPRINT_REGISTRY_CONFLICT");
    await run.entered.promise;
    run.execution.resolve();
    await run.settled.promise;
  } finally { run.execution.resolve(); await f.close(); }
});

test("a scheduling change between readiness and RUN transition rejects the old caller", { timeout: 5000 }, async () => {
  const f = await fixture();
  const captured = deferred();
  const resume = deferred();
  let executions = 0;
  try {
    const registry = { ...f.registry, assertReady: async (...args) => { const result = await f.registry.assertReady(...args); captured.resolve(); await resume.promise; return result; } };
    const dispatch = createSprintRunDispatch({ projectId: PROJECT, sprintRegistry: registry, sprintDagRunner: { runSprintLevels: () => { executions += 1; } }, logEvent: () => {} });
    const pending = dispatch({ projectId: PROJECT, sprintId: SPRINT });
    await captured.promise;
    await f.registry.setStatus({ sprintId: SPRINT, status: "blocked" });
    const current = await f.registry.setStatus({ sprintId: SPRINT, status: "ready" });
    resume.resolve();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT", retryable: false });
    assert.deepEqual(f.registry.get(SPRINT), current);
    assert.equal(executions, 0);
  } finally { resume.resolve(); await f.close(); }
});

for (const terminal of ["done", "failed"]) {
  test(`late ${terminal} callback cannot overwrite a newer RUN after block/ready`, { timeout: 5000 }, async () => {
    const f = await fixture();
    const oldRun = controlledRun(f);
    const newRun = controlledRun(f);
    try {
      await oldRun.dispatch({ projectId: PROJECT, sprintId: SPRINT });
      await oldRun.entered.promise;
      await f.registry.setStatus({ sprintId: SPRINT, status: "blocked" });
      await f.registry.setStatus({ sprintId: SPRINT, status: "ready" });
      await newRun.dispatch({ projectId: PROJECT, sprintId: SPRINT });
      await newRun.entered.promise;
      const winner = f.registry.get(SPRINT);
      if (terminal === "done") oldRun.execution.resolve();
      else oldRun.execution.reject(Object.assign(new Error("Old execution failed"), { code: "OLD_FAILURE" }));
      await oldRun.settled.promise;
      assert.deepEqual(f.registry.get(SPRINT), winner);
      assert.equal(oldRun.logs.at(-1).payload.error_code, "SPRINT_REGISTRY_CONFLICT");
      newRun.execution.resolve();
      await newRun.settled.promise;
      assert.equal(f.registry.get(SPRINT).status, "done");
    } finally { oldRun.execution.resolve(); newRun.execution.resolve(); await f.close(); }
  });
}

test("a reopened database rejects duplicate RUN of a durably running Sprint", { timeout: 5000 }, async () => {
  const f = await fixture();
  const run = controlledRun(f);
  const other = await createDatabaseService(f.options);
  try {
    await run.dispatch({ projectId: PROJECT, sprintId: SPRINT });
    await run.entered.promise;
    const plans = createHumanPlanStore({ projectId: PROJECT, database: other, fileService: f.fileService });
    const registry = createSprintRegistry({ projectId: PROJECT, database: other, plans });
    const restarted = controlledRun({ registry });
    const current = registry.get(SPRINT);
    await assert.rejects(restarted.dispatch({ projectId: PROJECT, sprintId: SPRINT }), { code: "SPRINT_ALREADY_RUNNING", retryable: false });
    assert.deepEqual(registry.get(SPRINT), current);
    await assert.rejects(restarted.dispatch({ projectId: "PROJECT-B", sprintId: SPRINT }), { code: "SPRINT_NOT_FOUND", statusCode: 404 });
    run.execution.resolve();
    await run.settled.promise;
  } finally { run.execution.resolve(); await other.close(); await f.close(); }
});

test("ticket checkpoint await cannot silently switch the production submission to a new Sprint basis", { timeout: 5000 }, async () => {
  const f = await fixture();
  const checkpointEntered = deferred();
  const resume = deferred();
  const submitted = [];
  try {
    const production = createApprovedTicketDispatch({ projectId: PROJECT, sprintRegistry: f.registry, integration: { submitTicket: async (input) => { submitted.push(input); return { status: "accepted" }; } } });
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) }, sprintRegistry: f.registry, ticketStatusStore: createTicketStatusStore({ projectId: PROJECT, database: f.database }), checkpoints: { load: async () => { checkpointEntered.resolve(); await resume.promise; return null; }, clear: async () => {} }, protocolStorage: { clearTask: async () => {} }, conversationStateStore: { clear: async () => {} }, dispatchTask: production });
    const pending = dispatch({ projectId: PROJECT, ticketId: TICKET.id });
    await checkpointEntered.promise;
    await f.registry.bindPlan({ sprintId: SPRINT, planId: "PLAN-A", revision: 1 });
    const current = await f.registry.setStatus({ sprintId: SPRINT, status: "ready" });
    resume.resolve();
    await assert.rejects(pending, { code: "SPRINT_REGISTRY_CONFLICT", retryable: false });
    assert.equal(submitted.length, 0);
    assert.deepEqual(f.registry.get(SPRINT), current);
  } finally { resume.resolve(); await f.close(); }
});

test("production submission requires scoped basis and includes exact binding in its payload", async () => {
  const f = await fixture();
  const submitted = [];
  try {
    const dispatch = createApprovedTicketDispatch({ projectId: PROJECT, sprintRegistry: f.registry, integration: { submitTicket: async (input) => { submitted.push(input); return { status: "accepted" }; } } });
    await assert.rejects(dispatch({ ticket: TICKET }), { code: "TICKET_RUN_BASIS_REQUIRED" });
    const sprintBasis = f.registry.get(SPRINT);
    await assert.rejects(dispatch({ ticket: TICKET, sprintBasis: { ...sprintBasis, project_id: "PROJECT-B" } }), { code: "TICKET_RUN_BASIS_REQUIRED" });
    await assert.rejects(dispatch({ ticket: TICKET, sprintBasis: { ...sprintBasis, plan_sha256: "0".repeat(64) } }), { code: "SPRINT_REGISTRY_CONFLICT" });
    await dispatch({ ticket: TICKET, sprintBasis, resume_from: { turn: 2 } });
    assert.deepEqual(submitted[0].payload.sprint_basis, Object.fromEntries(["project_id", "sprint_id", "version", "plan_id", "plan_revision", "plan_path", "plan_sha256"].map((key) => [key, sprintBasis[key]])));
    assert.deepEqual(submitted[0].payload.resume_from, { turn: 2 });
    assert.equal(submitted.length, 1);
  } finally { await f.close(); }
});

test("the actual DAG forwards the admission basis to every ticket dispatch", async () => {
  const basis = { project_id: PROJECT, sprint_id: SPRINT, version: 5 };
  const calls = [];
  let completed = false;
  const runner = createSprintDagRunner({ ticketStatusStore: { dependenciesReady: () => ({ ready: true }), getStatus: () => completed ? "done" : "pending" }, eventBus: { subscribe: () => () => {} }, dispatchTask: async (input) => { calls.push(input); completed = true; return { status: "completed" }; } });
  await runner.runSprintLevels({ projectId: PROJECT, sprintId: SPRINT, levels: [[TICKET]], sprintBasis: basis });
  assert.deepEqual(calls[0].sprintBasis, basis);
});

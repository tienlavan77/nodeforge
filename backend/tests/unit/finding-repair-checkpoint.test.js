// Verifies direct ticket submission and queued resumes retire archived finding instructions at the same Coder boundary.
// Durable repair receipts supply authority; unrelated or current finding keys still invoke their original source guard.
import assert from "node:assert/strict";
import test from "node:test";
import { dependencyRepairFixture, waitForDependency } from "../fixtures/dependency-repair-fixture.js";
import { prepareFindingRepairCheckpoint } from "../../src/modules/supervisor/finding-repair-checkpoint.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";

// Reconstructs a checkpoint created before archived finding keys were retired during dependency preparation.
async function fixture(t) {
  const f = await dependencyRepairFixture(t);
  const key = `sha256:${"d".repeat(64)}`;
  await f.files.atomicWrite({ path: f.contextPath, content: JSON.stringify({ ...f.context, source_repair_cycle_id: key.slice(7) }), replace: true });
  await f.request(); await f.coordinator.tick();
  await waitForDependency(f, (entry) => entry?.dispatch_result);
  const coder = { ...await f.checkpoints.load("UP"), review_repair_key: key };
  await f.checkpoints.save(coder);
  let findingCalls = 0;
  const workspace = { ...await f.services.resolveTicketWorkspace("UP"), beginFindingRepair: async () => {
    findingCalls++;
    throw Object.assign(new Error("Finding repair does not match its retained verified source."), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });
  } };
  const options = { taskId: "UP", projectId: "P", payload: { resume_from: await f.checkpoints.load("UP") },
    workspace, fileService: f.files, checkpoints: f.checkpoints };
  return { ...f, options, workspace, findingCalls: () => findingCalls };
}

test("direct submitTicket reaches current source preparation without replaying an archived finding repair", async (t) => {
  const f = await fixture(t);
  const boundary = Object.assign(new Error("Current source preparation reached"), { code: "CURRENT_SOURCE" });
  const integration = createNodeforgeTaskIntegration({ projectRoot: f.root, fileService: f.files, checkpointStore: f.checkpoints,
    supervisorManager: { startTask: async () => {} }, eventBus: { publish: async () => {} },
    agentResolver: { resolveAvailable: () => ({ agent_id: "CODER", role: "coder", provider: "codex" }) },
    handoffQueue: { enqueue: async () => ({ id: "JOB" }) },
    resolveTicketWorkspace: async () => ({ ...f.workspace, changeLedger: { snapshot: async () => { throw boundary; } } }) });
  await assert.rejects(integration.submitTicket({ ticket: { id: "UP", project_id: "P", verification_plan: [] },
    project_id: "P", payload: { ...f.options.payload, direct_code: true } }), { code: "CURRENT_SOURCE" });
  assert.equal(f.findingCalls(), 0);
  const coder = await f.checkpoints.load("UP");
  assert.equal(coder.review_repair_key, undefined);
  assert.equal(coder.last_completed_turn, 36);
  assert.equal(coder.session_id, "SDK-SESSION");
  assert.equal(f.options.payload.resume_from.review_repair_key, `sha256:${"d".repeat(64)}`);
});

test("only the matching archived finding key retires; other cycles and current findings keep source validation", async (t) => {
  for (const change of ["other_key", "other_cycle", "active_finding", "other_project"]) {
    await t.test(change, async (t) => {
      const f = await fixture(t);
      if (change === "other_key") f.options.payload.resume_from.review_repair_key = `sha256:${"e".repeat(64)}`;
      if (change === "other_cycle") f.options.payload.resume_from.review_cycle_id = "OTHER";
      if (change === "active_finding") {
        const context = await f.contexts.load("UP");
        await f.files.atomicWrite({ path: f.contextPath, content: JSON.stringify({ ...context, source_repair_cycle_id: "f".repeat(64) }), replace: true });
      }
      if (change === "other_project") f.options.projectId = "OTHER";
      await assert.rejects(prepareFindingRepairCheckpoint(f.options), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });
      assert.equal(f.findingCalls(), 1);
      assert.ok((await f.checkpoints.load("UP")).review_repair_key);
    });
  }
});

test("Reviewer resume leaves the Coder checkpoint and finding journal untouched", async (t) => {
  const f = await fixture(t);
  f.options.payload.review_resume = { agent_id: "CODER" };
  assert.equal(await prepareFindingRepairCheckpoint(f.options), f.options.payload);
  assert.equal(f.findingCalls(), 0);
  assert.ok((await f.checkpoints.load("UP")).review_repair_key);
});

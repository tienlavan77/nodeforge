// Business purpose: verifies Node's service resumes an approved handoff without replaying completed roles.
// Technical description: exercises the production store and checkpoint through the service with isolated file and Git adapters.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAmSeHandoffService } from "../../src/application/am-se-handoff-service.js";
import { createAmSeHandoffStore } from "../../src/application/am-se-handoff-store.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

// Business purpose: supplies one approved handoff and a durable production store for resume tests.
// Technical description: pins identity and records role invocations without replacing store transitions with an in-memory fake.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "handoff-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fileService = createFileService({ projectRoot: root });
  const store = createAmSeHandoffStore({ projectId: "PROJECT-TEST", fileService });
  const planJson = JSON.stringify({ title: "Implementation plan", objective: "Verify handoff", background: "Owner decision", scope: ["checkpoint"], constraints: ["approval"], assumptions: ["Owner approves the plan"], outcomes: [{ id: "O1", outcome: "Durable handoff", acceptance_criteria: ["report"], guardrails: ["no bypass"] }], evidence: [{ path: "backend/src/application/am-se-handoff-service.js", location: "L1", fact: "Existing handoff service" }], risks: [], verification: "Verify gate" });
  await fileService.atomicWrite({ path: "source.json", content: planJson, replace: false });
  const plan = { plan_id: "PLAN-TEST", revision: 2, sha256: "approved-sha", source_path: "source.json" };
  const id = "HANDOFF-PLAN-TEST-R1";
  await store.create({ handoffId: id, planId: plan.plan_id, planRevision: plan.revision, planSha256: plan.sha256, planSourcePath: plan.source_path, deliveryTarget: "se", amConversationId: "CONV-AM", seConversationId: "CONV-SE", rvConversationId: "CONV-RV" });
  await store.update(id, { phase: "plan_critique", status: "paused", critique_round: 1, history: [{ critique_round: 1, critique_status: "ALIGNED", se_critique: "Aligned" }] });
  const markdownPlanStore = { decide: async () => {}, assertApproved: async ({ revision, sha256 }) => {
    if (revision !== 2 || sha256 !== "approved-sha") throw Object.assign(new Error("wrong plan"), { code: "PLAN_APPROVAL_REQUIRED" });
    return { source_path: "source.json", project_id: "PROJECT-TEST", decision: { approver_id: "OWNER" } };
  } };
  const gitService = { getHead: async () => "head", status: async () => "", indexEntries: async () => "" };
  const service = createAmSeHandoffService({ projectId: "PROJECT-TEST", fileService, markdownPlanStore, handoffStore: store, gitService });
  return { service, store, id, plan };
}

test("pending SE after safe reconciliation shows Resume without a stale unknown error", async (t) => {
  const { service, store, id } = await fixture(t);
  await store.update(id, { phase: "implementation", status: "running", checkpoint: { generation: 5, execution_status: "pending", current_step: null, next_step: "se", attempt: 1, error_code: "HANDOFF_EXECUTION_UNKNOWN", results: [] } });
  const [handoff] = await service.listHandoffs();
  assert.equal(handoff.can_resume, true);
  assert.equal(handoff.can_reconcile, false);
  assert.equal(handoff.checkpoint.error_code, null);
  assert.equal((await store.get(id)).checkpoint.error_code, "HANDOFF_EXECUTION_UNKNOWN");
});

test("approval-paused handoff resumes SE then RV then AM with the same identity", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const input = { handoffId: f.id, approvedOwnerId: "OWNER", expectedRevision: 2, expectedSha256: "approved-sha", requestSystemEngineer: async (request) => { calls.push(["se", request.correlationId]); return { text: "SE report", execution_id: request.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; }, requestReviewer: async (request) => { calls.push(["rv", request.correlationId]); return { text: "RV checked\n[VERDICT: PASS]", execution_id: request.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }; }, requestArchitecture: async (prompt, conv, options) => { calls.push(["am", options.correlationId]); return { text: "AM accepted\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; } };
  const first = await f.service.resumeHandoff(input);
  assert.equal(first.handoff_id, f.id);
  assert.equal(first.checkpoint.next_step, "rv");
  assert.deepEqual(calls.map((call) => call[0]), ["se"]);
  const second = await f.service.resumeHandoff(input);
  assert.equal(second.checkpoint.next_step, "am");
  const third = await f.service.resumeHandoff(input);
  assert.equal(third.status, "completed");
  assert.deepEqual(calls.map((call) => call[0]), ["se", "rv", "am"]);
  assert.equal(new Set(calls.map((call) => call[1])).size, 3);
  assert.deepEqual((await f.store.get(f.id)).checkpoint.results.map((item) => item.step), ["se", "rv", "am"]);
  await assert.rejects(f.service.resumeHandoff(input), { code: "HANDOFF_ALREADY_COMPLETED" });
});

test("saved RV findings return to a new SE round without replaying the completed predecessor", async (t) => {
  const f = await fixture(t);
  const calls = [];
  const input = { handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async ({ round, prompt, correlationId }) => { calls.push(`se${round}`); if (round === 2) assert.match(prompt, /fix missing test/); return { text: `SE report ${round}`, execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; }, requestReviewer: async ({ round, correlationId }) => { calls.push(`rv${round}`); return { text: round === 1 ? "fix missing test\n[VERDICT: REVISE]" : "RV checked\n[VERDICT: PASS]", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }; }, requestArchitecture: async (prompt, conv, options) => { calls.push("am"); return { text: "AM accepted\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; } };
  for (let i = 0; i < 5; i += 1) await f.service.resumeHandoff(input);
  assert.deepEqual(calls, ["se1", "rv1", "se2", "rv2", "am"]);
  assert.deepEqual((await f.store.get(f.id)).checkpoint.results.map((item) => `${item.step}${item.round}`), ["se1", "rv1", "se2", "rv2", "am2"]);
});

test("missing RV result blocks acceptance while retaining completed SE evidence", async (t) => {
  const f = await fixture(t);
  const input = { handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async ({ correlationId }) => ({ text: "SE report", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }), requestReviewer: async ({ correlationId }) => ({ text: "Cannot confirm PASS", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }), requestArchitecture: async () => { throw new Error("AM must not run"); } };
  await f.service.resumeHandoff(input);
  const blocked = await f.service.resumeHandoff(input);
  assert.equal(blocked.checkpoint.execution_status, "blocked");
  assert.deepEqual(blocked.checkpoint.results.map((item) => item.step), ["se"]);
  assert.equal(blocked.status, "paused");
});

// Business purpose: reject unreceipted text even when it appears to contain a valid reviewer verdict.
// Technical description: exercise the durable store and service adapter to ensure stream text alone never advances SE to RV.
test("unreceipted SE text cannot advance the handoff", async (t) => {
  const f = await fixture(t);
  const result = await f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async () => "SE report", requestReviewer: async () => { throw new Error("RV must not run"); } });
  assert.equal(result.checkpoint.execution_status, "reconciliation_required");
  assert.equal(result.checkpoint.results.length, 0);
  assert.equal(result.checkpoint.current_step, "se");
});

test("resume refuses incorrect Owner or revision before invoking any role", async (t) => {
  const f = await fixture(t);
  const invoke = async () => { throw new Error("role must not run"); };
  await assert.rejects(f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "other", requestSystemEngineer: invoke }), { code: "PLAN_APPROVAL_OWNER_MISMATCH" });
  await assert.rejects(f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "OWNER", expectedRevision: 1, requestSystemEngineer: invoke }), { code: "HANDOFF_PLAN_MISMATCH" });
  assert.equal((await f.store.get(f.id)).checkpoint, undefined);
});

test("resume recovers a blocked handoff that exceeded max_rounds without HANDOFF_TRANSITION_INVALID", async (t) => {
  const f = await fixture(t);
  await f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async ({ correlationId }) => ({ text: "SE r1", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }) });
  const current = await f.store.get(f.id);
  await f.store.transition(f.id, current.checkpoint.generation, (rec) => ({
    ...rec,
    status: "paused",
    round: 4,
    max_rounds: 3,
    checkpoint: { ...rec.checkpoint, round: 4, current_step: null, next_step: null, execution_status: "blocked", error_code: "HANDOFF_RESULT_REQUIRED" }
  }));
  const steps = [];
  const resumed = await f.service.resumeHandoff({
    handoffId: f.id,
    approvedOwnerId: "OWNER",
    runToCompletion: true,
    requestSystemEngineer: async ({ round, correlationId }) => { steps.push(`se${round}`); return { text: "SE r4", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; },
    requestReviewer: async ({ round, correlationId }) => { steps.push(`rv${round}`); return { text: "RV PASS\n[VERDICT: PASS]", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }; },
    requestArchitecture: async (prompt, conv, options) => { steps.push("am"); return { text: "AM PASS\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; }
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(steps, ["se4", "rv4", "am"]);
});

test("resume recovers a running/pending handoff with stale next_step rv in a new round without HANDOFF_PREDECESSOR_REQUIRED", async (t) => {
  const f = await fixture(t);
  await f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async ({ correlationId }) => ({ text: "SE r1", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }) });
  const current = await f.store.get(f.id);
  await f.store.transition(f.id, current.checkpoint.generation, (rec) => ({
    ...rec,
    status: "running",
    round: 6,
    max_rounds: 6,
    checkpoint: { ...rec.checkpoint, round: 6, current_step: null, next_step: "rv", execution_status: "pending", error_code: null }
  }));
  const steps = [];
  const resumed = await f.service.resumeHandoff({
    handoffId: f.id,
    approvedOwnerId: "OWNER",
    runToCompletion: true,
    requestSystemEngineer: async ({ round, correlationId }) => { steps.push(`se${round}`); return { text: "SE r6", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; },
    requestReviewer: async ({ round, correlationId }) => { steps.push(`rv${round}`); return { text: "RV PASS\n[VERDICT: PASS]", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }; },
    requestArchitecture: async (prompt, conv, options) => { steps.push("am"); return { text: "AM PASS\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; }
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(steps, ["se6", "rv6", "am"]);
});

test("resume recovers a blocked handoff with stale current_step rv in a new round without HANDOFF_PREDECESSOR_REQUIRED", async (t) => {
  const f = await fixture(t);
  await f.service.resumeHandoff({ handoffId: f.id, approvedOwnerId: "OWNER", requestSystemEngineer: async ({ correlationId }) => ({ text: "SE r1", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }) });
  const current = await f.store.get(f.id);
  await f.store.transition(f.id, current.checkpoint.generation, (rec) => ({
    ...rec,
    status: "paused",
    round: 4,
    max_rounds: 3,
    checkpoint: { ...rec.checkpoint, round: 4, current_step: "rv", next_step: null, execution_status: "blocked", error_code: null }
  }));
  const steps = [];
  const resumed = await f.service.resumeHandoff({
    handoffId: f.id,
    approvedOwnerId: "OWNER",
    runToCompletion: true,
    requestSystemEngineer: async ({ round, correlationId }) => { steps.push(`se${round}`); return { text: "SE r4", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; },
    requestReviewer: async ({ round, correlationId }) => { steps.push(`rv${round}`); return { text: "RV PASS\n[VERDICT: PASS]", execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true }; },
    requestArchitecture: async (prompt, conv, options) => { steps.push("am"); return { text: "AM PASS\n[VERDICT: PASS]", execution_id: options.correlationId, terminal_status: "completed", result_evidence: { sdk_status: "completed" } }; }
  });
  assert.equal(resumed.status, "completed");
  assert.deepEqual(steps, ["se4", "rv4", "am"]);
});

// Business purpose: verifies that handoff recovery never invents review or repeats an uncertain execution.
// Technical description: exercises the production state machine with deterministic plan, workspace, and adapter fakes.
import assert from "node:assert/strict";
import test from "node:test";
import { createAmSeHandoffCheckpoint } from "../../src/application/am-se-handoff-checkpoint.js";

// Business purpose: prepares an isolated handoff with a pinned plan and controllable execution state.
// Technical description: emulates the store's generation guard and records every persisted intent and result.
function fixture() {
  const planId = "PLAN-TEST";
  let status = "";
  let changedBytes = "initial";
  let index = "";
  let receipt = null;
  let revision = 2;
  let record = { handoff_id: "HANDOFF-TEST", project_id: "PROJECT-TEST", plan_id: planId, plan_revision: 2, plan_sha256: "plan-hash", plan_source_path: "source.json", phase: "implementation", delivery_target: "se", status: "running", round: 1, max_rounds: 3, se_conversation_id: "CONV-SE", rv_conversation_id: "CONV-RV", am_conversation_id: "CONV-AM" };
  const writes = [];
  const store = {
    get: async () => structuredClone(record),
    transition: async (id, generation, transform) => {
      assert.equal(id, record.handoff_id);
      if ((record.checkpoint?.generation ?? 0) !== generation) throw Object.assign(new Error("stale"), { code: "HANDOFF_STALE" });
      const next = transform(structuredClone(record));
      next.checkpoint.generation = generation + 1;
      record = next;
      writes.push(structuredClone(next));
      return structuredClone(record);
    }
  };
  const markdownPlanStore = { assertApproved: async ({ revision: value, sha256 }) => {
    if (value !== revision || sha256 !== "plan-hash") throw Object.assign(new Error("plan mismatch"), { code: "PLAN_APPROVAL_REQUIRED" });
    return { source_path: "source.json" };
  } };
  const gitService = { getHead: async () => "head", status: async () => status, indexEntries: async () => index };
  const machine = createAmSeHandoffCheckpoint({ store, markdownPlanStore, fileService: { readFile: async ({ path }) => path === "source.json" ? "source" : changedBytes }, gitService, projectId: "PROJECT-TEST", executionCheckpoint: { load: async () => receipt } });
  return { machine, writes, get record() { return record; }, setStatus(value) { status = value; }, setBytes(value) { changedBytes = value; }, setIndex(value) { index = value; }, setReceipt(value) { receipt = value; }, setRevision(value) { revision = value; } };
}

// Business purpose: prevents a crash between SDK completion and handoff persistence from replaying SE mutations.
// Technical description: recovers only a matching stopped SDK receipt and proves a missing result cannot advance or invoke another role.
test("stopped SDK receipt completes the original fenced attempt without replay", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  let finish;
  const pending = f.machine.resume("HANDOFF-TEST", { invoke: () => new Promise((resolve) => { finish = resolve; }) });
  while (!finish) await new Promise((resolve) => setImmediate(resolve));
  const executionId = f.record.checkpoint.execution_id;
  f.setReceipt({ execution_id: executionId, status: "completed", runner_stopped_at: new Date().toISOString(), pending_tool_calls: [], completed_tool_calls: [], handoff_result: { execution_id: executionId, terminal_status: "completed", text: "SE report", result_evidence: { sdk_status: "completed", turn_completed: true } } });
  const recovered = await f.machine.resume("HANDOFF-TEST", { invoke: () => { throw new Error("replayed"); } });
  assert.equal(recovered.checkpoint.next_step, "rv");
  assert.equal(recovered.checkpoint.results[0].execution_id, executionId);
  finish({ execution_id: executionId, terminal_status: "completed", text: "late reply", result_evidence: { sdk_status: "completed" } });
  await assert.rejects(pending, { code: "HANDOFF_STALE" });
});

test("handoff saves intent before each role and only completes after SE, RV and AM evidence", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  const invoke = async ({ step, executionId }) => {
    assert.equal(f.record.checkpoint.execution_status, "running");
    assert.equal(f.record.checkpoint.execution_id, executionId);
    return { text: `${step} result`, execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, verdict: "PASS" };
  };
  await f.machine.resume("HANDOFF-TEST", { invoke });
  assert.equal(f.record.checkpoint.next_step, "rv");
  await f.machine.resume("HANDOFF-TEST", { invoke });
  assert.equal(f.record.checkpoint.next_step, "am");
  await f.machine.resume("HANDOFF-TEST", { invoke });
  assert.equal(f.record.status, "completed");
  assert.deepEqual(f.record.checkpoint.results.map((entry) => entry.step), ["se", "rv", "am"]);
  assert.equal(f.writes.filter((entry) => entry.checkpoint.execution_status === "running").length, 3);
  await assert.rejects(f.machine.resume("HANDOFF-TEST", { invoke }), { code: "HANDOFF_ALREADY_COMPLETED" });
});

test("AM PASS completes on the last allowed round without creating another SE attempt", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  f.record.max_rounds = 1;
  for (const step of ["se", "rv", "am"]) {
    await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: `${step} evidence`, verdict: "PASS" }) });
  }
  assert.equal(f.record.status, "completed");
  assert.equal(f.record.checkpoint.round, 1);
});

test("reviewer revision loops to a fresh SE attempt and rejects missing reviewer verdict", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "SE report" }) });
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "findings", verdict: "REVISE" }) });
  assert.equal(f.record.checkpoint.next_step, "se");
  assert.equal(f.record.checkpoint.round, 2);
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "SE repair" }) });
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "no verdict" }) });
  assert.equal(f.record.checkpoint.execution_status, "blocked");
  assert.equal(f.record.checkpoint.results.length, 3);
  assert.notEqual(f.record.status, "completed");
});

test("simultaneous resume claims one intent; interrupted SE cannot retry before reconciliation", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const first = f.machine.resume("HANDOFF-TEST", { invoke: async () => { await pending; throw new Error("provider disconnected"); } });
  while (f.record.checkpoint.execution_status !== "running") await new Promise((resolve) => setImmediate(resolve));
  await assert.rejects(f.machine.resume("HANDOFF-TEST", { invoke: async () => { throw new Error("duplicate call"); } }), { code: "HANDOFF_BUSY" });
  release();
  await first;
  assert.equal(f.record.checkpoint.execution_status, "reconciliation_required");
  await assert.rejects(f.machine.resume("HANDOFF-TEST", { invoke: async () => { throw new Error("unsafe retry"); } }), { code: "HANDOFF_RECONCILIATION_REQUIRED" });
  assert.deepEqual(await f.machine.reconcile("HANDOFF-TEST"), { classification: "blocked", handoff_id: "HANDOFF-TEST" });
});

test("stopped SE runner after a lost result needs operator evidence before a new attempt", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  const original = f.record.checkpoint.generation;
  f.record.checkpoint = { ...f.record.checkpoint, generation: original + 1, current_step: "se", next_step: null, execution_status: "running", execution_id: "lost-result", attempt: 1 };
  f.setReceipt({ status: "interrupted", runner_stopped_at: "2026-01-01T00:00:00Z", pending_tool_calls: [], completed_tool_calls: [], last_completed_step: 0 });
  assert.deepEqual((await f.machine.reconcile("HANDOFF-TEST")).classification, "operator_decision");
  assert.equal(f.record.checkpoint.execution_status, "running");
  assert.deepEqual((await f.machine.reconcile("HANDOFF-TEST", { operatorApproved: true })).classification, "safe_to_resume");
  assert.equal(f.record.checkpoint.execution_status, "pending");
  assert.equal(f.record.checkpoint.error_code, null);
  assert.equal(f.record.checkpoint.next_step, "se");
  assert.equal(f.record.checkpoint.results.length, 0);
});

// Business purpose: repairs a partially persisted first-SE reset without authorizing a duplicate execution.
// Technical description: accepts only a pending, result-free SE checkpoint with no execution identity and re-pins the observed workspace through the generation-fenced transition.
test("reconciles a partially reset first SE checkpoint", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST", "project-owner");
  const original = f.record.checkpoint.generation;
  f.record.checkpoint = { ...f.record.checkpoint, generation: original + 1, execution_status: "pending", next_step: "se", current_step: null, execution_id: null, error_code: "HANDOFF_EXECUTION_UNKNOWN", started_at: "2026-01-01T00:00:00Z", attempt: 0, results: [] };
  assert.deepEqual((await f.machine.reconcile("HANDOFF-TEST")).classification, "operator_decision");
  assert.deepEqual((await f.machine.reconcile("HANDOFF-TEST", { operatorApproved: true })).classification, "safe_to_resume");
  assert.equal(f.record.checkpoint.execution_status, "pending");
  assert.equal(f.record.checkpoint.error_code, null);
  assert.equal(f.record.checkpoint.next_step, "se");
  assert.equal(f.record.checkpoint.execution_id, null);
  assert.equal(f.record.checkpoint.started_at, null);
  assert.equal(f.record.checkpoint.results.length, 0);
});

test("RV recovery refuses retry without verified read-only stop evidence", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "SE done" }) });
  const original = f.record.checkpoint.generation;
  f.record.checkpoint = { ...f.record.checkpoint, generation: original + 1, current_step: "rv", next_step: null, execution_status: "running", execution_id: "rv-lost-result", attempt: 2 };
  f.setReceipt({ status: "interrupted", runner_stopped_at: "2026-01-01T00:00:00Z", pending_tool_calls: [], completed_tool_calls: [], read_only_enforced: false });
  assert.equal((await f.machine.reconcile("HANDOFF-TEST", { operatorApproved: true })).classification, "blocked");
  f.setReceipt({ status: "interrupted", runner_stopped_at: "2026-01-01T00:00:00Z", pending_tool_calls: [], completed_tool_calls: [], read_only_enforced: true });
  assert.equal((await f.machine.reconcile("HANDOFF-TEST", { operatorApproved: true })).classification, "safe_to_resume");
  assert.equal(f.record.checkpoint.next_step, "rv");
});

test("stale completion cannot override a newer checkpoint generation", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  await assert.rejects(f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => {
    f.record.checkpoint.generation += 1;
    return { execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "late SE" };
  } }), { code: "HANDOFF_STALE" });
  assert.equal(f.record.checkpoint.results.length, 0);
});

test("missing AM result remains blocked after a real reviewer PASS", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "SE report" }) });
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "RV checked", verdict: "PASS" }) });
  await f.machine.resume("HANDOFF-TEST", { invoke: async ({ executionId }) => ({ execution_id: executionId, terminal_status: "completed", result_evidence: { sdk_status: "completed" }, read_only_enforced: true, text: "AM response" }) });
  assert.equal(f.record.checkpoint.execution_status, "blocked");
  assert.equal(f.record.checkpoint.results.length, 2);
  assert.notEqual(f.record.status, "completed");
});

test("plan and workspace mismatches reject resume without another intent", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST");
  f.setRevision(3);
  await assert.rejects(f.machine.resume("HANDOFF-TEST"), { code: "PLAN_APPROVAL_REQUIRED" });
  f.setRevision(2);
  f.setStatus(" M changed.js\0");
  await assert.rejects(f.machine.resume("HANDOFF-TEST"), { code: "HANDOFF_WORKSPACE_MISMATCH" });
  assert.equal(f.writes.length, 1);
});

test("staged blob changes under identical MM status and working bytes invalidate the baseline", async () => {
  const f = fixture();
  f.setStatus("MM changed.js\0");
  f.setIndex(`100644 ${"a".repeat(40)} 0\tchanged.js\0`);
  await f.machine.initialize("HANDOFF-TEST");
  f.setIndex(`100644 ${"b".repeat(40)} 0\tchanged.js\0`);
  await assert.rejects(f.machine.resume("HANDOFF-TEST"), { code: "HANDOFF_WORKSPACE_MISMATCH" });
  assert.equal(f.writes.length, 1);
});

test("first SE checkpoint can adopt current workspace only with exact Owner identity and no tool receipts", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST", "project-owner");
  f.setStatus(" M changed.js\0");
  const drift = await f.machine.workspaceStatus("HANDOFF-TEST");
  assert.equal(drift.matches, false);
  assert.deepEqual(drift.paths, ["changed.js"]);
  assert.equal(drift.can_adopt, true);
  await assert.rejects(f.machine.adoptWorkspace("HANDOFF-TEST", { approvedOwnerId: "wrong", expectedRevision: 2, expectedSha256: "plan-hash" }), { code: "HANDOFF_IDENTITY_INVALID" });
  const args = { approvedOwnerId: "project-owner", expectedRevision: 2, expectedSha256: "plan-hash" };
  assert.equal((await f.machine.adoptWorkspace("HANDOFF-TEST", args)).classification, "baseline_adopted");
  assert.equal((await f.machine.workspaceStatus("HANDOFF-TEST")).matches, true);
  assert.equal((await f.machine.workspaceStatus("HANDOFF-TEST")).can_adopt, false);
  await assert.rejects(f.machine.adoptWorkspace("HANDOFF-TEST", args), { code: "HANDOFF_BASELINE_ADOPTION_UNSAFE" });
  f.setBytes("different");
  await assert.rejects(f.machine.resume("HANDOFF-TEST"), { code: "HANDOFF_WORKSPACE_MISMATCH" });
  assert.deepEqual((await f.machine.workspaceStatus("HANDOFF-TEST")).paths, ["changed.js"]);
});

test("baseline adoption rejects unverified or tool-using prior SE attempts", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST", "project-owner");
  const args = { approvedOwnerId: "project-owner", expectedRevision: 2, expectedSha256: "plan-hash" };
  await f.machine.resume("HANDOFF-TEST", { invoke: async () => { throw new Error("disconnected"); } });
  f.setStatus(" M changed.js\0");
  assert.equal((await f.machine.workspaceStatus("HANDOFF-TEST")).can_adopt, false);
  await assert.rejects(f.machine.adoptWorkspace("HANDOFF-TEST", args), { code: "HANDOFF_BASELINE_ADOPTION_UNSAFE" });
  const execution_id = f.record.checkpoint.execution_id;
  f.setReceipt({ execution_id, runner_stopped_at: "2026-01-01T00:00:00Z", status: "interrupted", pending_tool_calls: [], completed_tool_calls: [{ tool_name: "edit_diff" }], last_completed_step: 1 });
  assert.equal((await f.machine.reconcile("HANDOFF-TEST", { operatorApproved: true })).classification, "blocked");
  await assert.rejects(f.machine.adoptWorkspace("HANDOFF-TEST", args), { code: "HANDOFF_BASELINE_ADOPTION_UNSAFE" });
  assert.equal(f.record.checkpoint.results.length, 0);
});

test("legacy fingerprints report limited diagnostics and can adopt only before execution", async () => {
  const f = fixture();
  await f.machine.initialize("HANDOFF-TEST", "project-owner");
  delete f.record.checkpoint.workspace.files;
  f.setStatus(" M changed.js\0");
  const drift = await f.machine.workspaceStatus("HANDOFF-TEST");
  assert.equal(drift.reason, "legacy_baseline");
  assert.deepEqual(drift.paths, []);
  assert.equal((await f.machine.adoptWorkspace("HANDOFF-TEST", { approvedOwnerId: "project-owner", expectedRevision: 2, expectedSha256: "plan-hash" })).classification, "baseline_adopted");
});

test("content changes under identical Git status invalidate the workspace baseline", async () => {
  const f = fixture();
  f.setStatus(" M changed.js\0?? new.js\0");
  await f.machine.initialize("HANDOFF-TEST");
  f.setBytes("different bytes");
  await assert.rejects(f.machine.resume("HANDOFF-TEST"), { code: "HANDOFF_WORKSPACE_MISMATCH" });
  assert.equal(f.writes.length, 1);
});

// Business purpose: prove interrupted critique resumes unfinished transitions without repeating saved agent work.
// Technical description: exercises the real critique checkpoint with generation-fenced storage and deterministic adapters.
import test from "node:test";
import assert from "node:assert/strict";
import { createAmSeCritiqueCheckpoint } from "../../src/application/am-se-critique-checkpoint.js";
import { resumeAmSeCritique } from "../../src/application/am-se-critique-resume.js";
const planJson = { title: "Recovery", objective: "Resume critique", background: "Interrupted round", scope: ["handoff"], constraints: ["saved results"], assumptions: ["owner approves"], outcomes: [{ id: "O1", outcome: "Recovery", acceptance_criteria: ["continues"], guardrails: ["no replay"] }], evidence: [{ path: "backend/src/application/am-se-handoff-service.js", location: "L1", fact: "Handoff" }], risks: [], verification: "node --test" };

// Business purpose: reproduce durable pause boundaries with the same checkpoint checks as production.
// Technical description: maintains cloned records, validates generation claims and counts invoked roles and finalization.
async function fixture(results = [], executionCheckpoint) {
  let record = { handoff_id: "H", project_id: "P", phase: "plan_critique", status: "critiquing",
    plan_id: "PLAN", plan_revision: 1, plan_sha256: "sha", plan_source_path: "plan.json",
    am_conversation_id: "AM", se_conversation_id: "SE", delivery_target: "se",
    approval_mode: "explicit_owner_command", max_critique_rounds: 2, history: [] };
  const store = {
    get: async () => structuredClone(record),
    update: async (_id, patch) => { record = { ...record, ...patch }; return structuredClone(record); },
    transition: async (_id, generation, update) => {
      assert.equal(generation, record.critique_checkpoint?.generation ?? 0);
      record = update(structuredClone(record));
      record.critique_checkpoint.generation = generation + 1;
      return structuredClone(record);
    }
  };
  const fileService = { readFile: async () => JSON.stringify(planJson) };
  const gitService = { getHead: async () => "head", status: async () => "", indexEntries: async () => "" };
  const critique = createAmSeCritiqueCheckpoint({ projectId: "P", store, fileService, gitService, executionCheckpoint });
  await critique.initialize("H");
  record.critique_checkpoint.results = results.map((item) => ({ round: 1, execution_id: item.step, ...item }));
  record.critique_checkpoint.next_step = results.some((item) => item.step === "am") ? "se" : results.length ? "am" : "se";
  const calls = [];
  const options = { handoffId: "H", projectId: "P", store, critique, fileService, withEvidence: false,
    applyRevision: async ({ currentPlan, currentPlanJson, rawAmReply }) => { calls.push("apply"); return { currentPlan, currentPlanJson, cleanReply: rawAmReply }; },
    se: async ({ phase, round }) => { calls.push(`se:${phase}:${round}`); return "[CRITIQUE: ALIGNED]"; },
    am: async () => { calls.push("am"); return "Clarified"; },
    finish: async (current) => { calls.push("finish"); return { done: true, round: current.critique_round }; }
  };
  return { options, calls, get: () => structuredClone(record), set: (update) => { record = update(record); } };
}

// Business purpose: retain a completed provider answer when a crash occurred before saving the handoff result.
// Technical description: verifies terminal execution receipts can recover the result without replaying SDK work.
test("completed SDK receipt recovers interrupted SE without another invocation", async () => {
  const f = await fixture([], { load: async (conversation, executionId) => {
    assert.equal(conversation, "SE");
    assert.equal(executionId, "stopped");
    return { execution_id: executionId, runner_stopped_at: "now", status: "completed", pending_tool_calls: [],
      handoff_result: { execution_id: executionId, text: "Aligned [CRITIQUE: ALIGNED]", terminal_status: "completed", result_evidence: { sdk_status: "completed" } } };
  } });
  f.set((r) => ({ ...r, critique_checkpoint: { ...r.critique_checkpoint, current_step: "se", next_step: null, execution_status: "unknown", execution_id: "stopped" } }));
  await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["finish"]);
  assert.equal(f.get().critique_checkpoint.results[0].execution_id, "stopped");
});

test("mismatched receipt cannot certify interrupted execution", async () => {
  const f = await fixture([], { load: async () => ({ execution_id: "different", runner_stopped_at: "now", status: "completed", pending_tool_calls: [], handoff_result: { execution_id: "different", text: "Aligned [CRITIQUE: ALIGNED]", terminal_status: "completed", result_evidence: { sdk_status: "completed" } } }) });
  f.set((r) => ({ ...r, critique_checkpoint: { ...r.critique_checkpoint, current_step: "se", next_step: null, execution_status: "unknown", execution_id: "stopped" } }));
  await assert.rejects(resumeAmSeCritique(f.options), { code: "HANDOFF_CRITIQUE_RECOVERY_REQUIRED" });
  assert.deepEqual(f.calls, []);
});

test("saved SE and AM answers finish round one and invoke only SE round two", async () => {
  const f = await fixture([{ step: "se", text: "Needs clarification [CRITIQUE: DISCUSS]" }, { step: "am", text: "Clarified" }]);
  const result = await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["apply", "se:plan_critique:2", "finish"]);
  assert.equal(result.done, true);
  assert.equal(f.get().critique_checkpoint.execution_status, "completed");
  assert.deepEqual(f.get().history.map((item) => item.critique_round), [1, 2]);
});

test("saved aligned SE answer reaches approval without invoking AM", async () => {
  const f = await fixture([{ step: "se", text: "Agreed [CRITIQUE: ALIGNED]" }]);
  await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["finish"]);
});

test("saved discussing SE answer resumes AM then continues the next round", async () => {
  const f = await fixture([{ step: "se", text: "Discuss [CRITIQUE: DISCUSS]" }]);
  await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["am", "apply", "se:plan_critique:2", "finish"]);
});

test("completed critique resumes only delivery finalization", async () => {
  const f = await fixture();
  f.set((r) => ({ ...r, critique_checkpoint: { ...r.critique_checkpoint, execution_status: "completed", next_step: null } }));
  await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["finish"]);
});

test("unknown active attempt without stopped receipt does not replay an agent", async () => {
  const f = await fixture();
  f.set((r) => ({ ...r, critique_checkpoint: { ...r.critique_checkpoint, execution_status: "unknown", current_step: "se", next_step: null, execution_id: "uncertain" } }));
  await assert.rejects(resumeAmSeCritique(f.options), { code: "HANDOFF_CRITIQUE_RECOVERY_REQUIRED" });
  assert.deepEqual(f.calls, []);
});

test("manual critique without consensus pauses instead of implementing", async () => {
  const f = await fixture([{ step: "se", text: "Discuss [CRITIQUE: DISCUSS]" }, { step: "am", text: "Clarified" }]);
  f.set((r) => ({ ...r, max_critique_rounds: 1, approval_mode: "manual_panel_approval" }));
  const result = await resumeAmSeCritique(f.options);
  assert.equal(result.reason, "CRITIQUE_CONSENSUS_REQUIRED");
  assert.deepEqual(f.calls, ["apply"]);
  assert.equal((await resumeAmSeCritique({ ...f.options, finish: async (r) => ({ reason: r.error_code }) })).reason, "CRITIQUE_CONSENSUS_REQUIRED");
});

test("failed round finalization retries saved AM output without another SDK request", async () => {
  const f = await fixture([{ step: "se", text: "Discuss [CRITIQUE: DISCUSS]" }, { step: "am", text: "Clarified" }]);
  await assert.rejects(resumeAmSeCritique({ ...f.options, applyRevision: async () => { throw new Error("storage unavailable"); } }), /storage unavailable/);
  assert.deepEqual(f.calls, []);
  await resumeAmSeCritique(f.options);
  assert.deepEqual(f.calls, ["apply", "se:plan_critique:2", "finish"]);
});

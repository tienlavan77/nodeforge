import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { createWorkflowRuleEvaluator } from "../../src/modules/rules/workflow-rule-evaluator.js";

const projectId = "PROJECT-workflow-rules";

test("evaluates WF-001 dependency gates and WF-002 task plus roadmap transition requirements", async () => {
  const { evaluator } = createEvaluator();
  const dependencyPass = await evaluator.execute({ trigger: "commit.create", context: { dependencies: [{ status: "APPROVED" }] } }, async () => "created");
  const dependencyFail = await evaluator.execute({ trigger: "commit.create", context: { dependencies: [{ status: "BLOCKED" }] } }, async () => "must-not-run");
  const transitionPass = await evaluator.execute({
    trigger: "commit.transition",
    context: {
      transition: { from: "PLANNED", to: "IN_PROGRESS", actor: "sprint_lead" },
      task: { workflow_state: "PLANNED" },
      roadmap: { commit: { id: "NF-067" } }
    }
  }, async () => "started");

  assert.equal(dependencyPass.allowed, true);
  assert.equal(dependencyFail.allowed, false);
  assert.equal(transitionPass.allowed, true);
});

test("allows WF-003 handoff when Node has valid Builder evidence", async () => {
  const { evaluator } = createEvaluator();
  let executed = false;

  const result = await evaluator.execute({ trigger: "commit.handoff", context: handoffContext() }, async () => {
    executed = true;
    return "handed-off";
  });

  assert.equal(executed, true);
  assert.equal(result.allowed, true);
  assert.equal(result.outcomes[0].rule_id, "WF-003");
  assert.equal(result.outcomes[0].passed, true);
});

test("blocks WF-003 when Builder evidence is missing and emits a violation", async () => {
  const { evaluator, events } = createEvaluator();
  let executed = false;
  const context = handoffContext();
  context.builder_evidence = [];

  const result = await evaluator.execute({ trigger: "commit.handoff", context }, async () => { executed = true; });

  assert.equal(executed, false);
  assert.equal(result.allowed, false);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].payload, {
    rule_id: "WF-003",
    trigger: "commit.handoff",
    severity: "high",
    enforcement: "blocking",
    reason: "Condition artifact_requirement was not satisfied."
  });
});

test("blocks WF-003 when Builder evidence is invalid", async () => {
  const { evaluator } = createEvaluator();
  const context = handoffContext();
  delete context.builder_evidence[0].builder_id;

  const result = await evaluator.execute({ trigger: "commit.handoff", context }, async () => "must-not-run");

  assert.equal(result.allowed, false);
  assert.equal(result.outcomes[0].passed, false);
});

test("enforces WF-005 allowlist for paths inside and outside roadmap.commit.allowed_change_areas", async () => {
  const { evaluator } = createEvaluator();
  const context = { roadmap: { commit: { allowed_change_areas: ["src/modules/rules/**"] } } };

  const allowed = await evaluator.execute({ trigger: "file.change", context: { ...context, path: "src/modules/rules/permission-evaluator.js", actor: "builder", action: "write_implementation_code" } }, async () => "changed");
  const denied = await evaluator.execute({ trigger: "file.change", context: { ...context, path: "src/modules/context/context.js", actor: "builder", action: "write_implementation_code" } }, async () => "must-not-run");

  assert.equal(allowed.allowed, true);
  assert.equal(denied.allowed, false);
  assert.equal(denied.outcomes.find(({ rule_id }) => rule_id === "WF-005").passed, false);
});

test("uses review-result and verification-result for WF-006 and verification-run results for WF-007", async () => {
  const { evaluator } = createEvaluator();
  const result = await evaluator.execute({
    trigger: "review.complete",
    context: reviewContext()
  }, async () => "approved");

  assert.equal(result.allowed, true);
  assert.deepEqual(result.outcomes.map(({ rule_id, passed }) => ({ rule_id, passed })), [{ rule_id: "WF-006", passed: true }, { rule_id: "WF-007", passed: true }]);
});

test("blocks review completion when verification result or run evidence does not satisfy the rule", async () => {
  const { evaluator } = createEvaluator();
  const context = reviewContext();
  context.verification_result.ready_for_review = false;
  context.verification_run.checks[0].result_ref = "MISSING-RESULT";

  const result = await evaluator.execute({ trigger: "review.complete", context }, async () => "must-not-run");

  assert.equal(result.allowed, false);
  assert.equal(result.outcomes.find(({ rule_id }) => rule_id === "WF-006").passed, false);
  assert.equal(result.outcomes.find(({ rule_id }) => rule_id === "WF-007").passed, false);
});

test("returns an emitted non-blocking result for an orchestrator rule failure", async () => {
  const ruleset = { ruleset_id: "RULESET-orchestrator", version: "1.0.0", source: "test", rules: [{
    id: "WF-ORCHESTRATOR", description: "Require a release approval.", severity: "warning", enforcement: "orchestrator", trigger: "workflow.transition",
    condition: { kind: "owner_gate", requires_owner_approval_for: ["release"] }, enabled: true, priority: 1
  }] };
  const { evaluator, events } = createEvaluator(ruleset);

  const result = await evaluator.execute({ trigger: "workflow.transition", context: { owner_approvals: [] } }, async () => "continued");

  assert.equal(result.allowed, true);
  assert.equal(result.executed, true);
  assert.equal(result.outcomes[0].passed, false);
  assert.equal(events[0].payload.enforcement, "orchestrator");
});

function createEvaluator(ruleset) {
  const bus = new EventEmitter();
  const events = [];
  bus.on("event", (event) => events.push(event));
  return {
    events,
    evaluator: createWorkflowRuleEvaluator({
      ...(ruleset ? { ruleset } : {}),
      projectId,
      internalBus: bus,
      createEventId: () => "EVT-rule-violation",
      clock: () => new Date("2026-08-18T10:00:00Z")
    })
  };
}

function handoffContext() {
  return {
    roadmap: { commit: { id: "NF-067" } },
    task: { id: "TASK-067", workflow_state: "READY_FOR_REVIEW" },
    builder_evidence: [{
      id: "EVIDENCE-067",
      project_id: projectId,
      task_id: "TASK-067",
      session_id: "SESSION-067",
      builder_id: "AGENT-BUILDER",
      evidence_type: "implementation_summary",
      payload: { summary: "Implemented the requested handoff." },
      created_at: "2026-08-18T10:00:00Z"
    }]
  };
}

function reviewContext() {
  return {
    transition: { from: "READY_FOR_REVIEW", to: "APPROVED", actor: "reviewer" },
    review_result: { status: "approved", findings: [] },
    verification_result: { ready_for_review: true },
    verification_run: { level: "full", status: "passed", checks: [{ status: "passed", command: "npm test", result_ref: "TEST-067" }] },
    results: { "TEST-067": { id: "TEST-067", status: "passed" } },
    change_kinds: ["shared_contract"]
  };
}

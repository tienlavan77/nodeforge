// Reproduces saved numeric-priority handoff failures against real Sprint admission without accessing production data.
import assert from "node:assert/strict";
import test from "node:test";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";

const markdown = "# Plan: API\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Publish API | Approved API works | No RUN |\n\n## 6. Risks\nAssumption: review before execution.";

// Supplies the observed 1,1,2 priorities on an otherwise valid, source-bound Sprint draft.
function candidate(priorities = [1, 1, 2]) {
  return { id: "SPRINT-PRIORITY", roadmap_id: "ROADMAP-PRIORITY", project_id: "PROJECT-PRIORITY", objective: "Publish API", exit_criteria: ["Approved API works"],
    tickets: priorities.map((priority, index) => ({ id: `TICKET-PRIORITY-${index + 1}`, title: `API work ${index + 1}`, objective: "Publish API", priority, implementation_type: ["backend"], file_budget: 4, outcome_refs: ["O1"], dependencies: [], acceptance_criteria: ["Approved API works"], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/plan-handoff-priority-retry.test.js" }] })),
    human_plan: { outcome: "Working API", in_scope: "API", out_of_scope: "UI", approach: "Validate requests", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Approved plan"], acceptance_criteria: ["Approved API works"] } };
}

// Retains the existing receipt across service instances while executing the production ingestion and schema gates.
function fixture(requestPlan, draft = candidate()) {
  const plan = { plan_id: "PLAN-PRIORITY", revision: 1, project_id: "PROJECT-PRIORITY", format: "markdown", sha256: "a".repeat(64), markdown };
  const receipt = { plan_id: plan.plan_id, revision: 1, project_id: plan.project_id, sha256: plan.sha256, status: "generated", sprint_id: draft.id, generated_json: JSON.stringify(draft), error_code: "SPRINT_PLAN_HANDOFF_FAILED", error_message: "Sprint Leader returned invalid sprint plan: /tickets/0/priority must be string; /tickets/0/priority must be equal to one of the allowed values; /tickets/1/priority must be string; /tickets/2/priority must be string" };
  const database = {
    transaction: (callback) => callback(),
    all: () => [{ ...receipt }],
    run: (sql, parameters) => {
      if (sql.startsWith("INSERT OR IGNORE")) return;
      const fields = sql.match(/ SET (.+) WHERE /)?.[1].split(",");
      assert.ok(fields, "Only the existing handoff UPDATE statements are expected");
      let position = 0;
      for (const field of fields) {
        const [, name, value] = field.match(/^(\w+)=(\?|NULL)$/) ?? [];
        assert.ok(name, `Unexpected receipt assignment ${field}`);
        receipt[name] = value === "NULL" ? null : parameters[position++];
      }
      assert.equal(parameters[position], plan.plan_id);
      assert.equal(parameters[position + 1], plan.revision);
    }
  };
  const requests = []; const drafts = []; const events = []; let registered = false;
  const sprintRegistry = { get: () => registered ? { plan_id: "PLAN-CHILD", plan_revision: 1, plan_sha256: "child-digest", plan_path: "child.json" } : null };
  const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-PRIORITY" }) };
  const orchestration = createSprintOrchestrationService({
    sprintPlans: { getSprintById: () => null }, sprintRegistry, agentRoleResolver,
    agentGateway: { stream: () => { throw new Error("Handoff must never RUN agents"); } },
    publisher: { publish: (event) => events.push(event) },
    draftPlan: async (generated) => { drafts.push(generated); registered = true; return { plan_id: "PLAN-CHILD", revision: 1, sha256: "child-digest", file_path: "child.json" }; }
  });
  const create = () => createPlanHandoffService({ projectId: plan.project_id, database, sprintRegistry, agentRoleResolver,
    markdownPlanStore: { assertApproved: async () => plan },
    planStore: { assertExecutable: async () => ({}), getRevision: async () => ({ project_id: plan.project_id, sprint_id: draft.id, sha256: "child-digest", file_path: "child.json", proposal_id: `${plan.plan_id}-R1-${plan.sha256}` }) },
    sprintPlanLeader: { requestPlan: async (input) => { requests.push(input); return requestPlan(requests.length, input); } }, sprintOrchestration: orchestration });
  return { create, plan, receipt, requests, drafts, events, orchestration };
}

test("owner retry repairs the saved numeric priorities without regenerating scope or changing other fields", async () => {
  const state = fixture((_attempt, input) => {
    assert.match(input.brief, /priority-only repair/);
    assert.match(input.brief, /low\|medium\|normal\|high\|critical/);
    const repaired = candidate(["high", "high", "normal"]);
    repaired.objective = "Unapproved objective"; repaired.tickets[0].acceptance_criteria = ["Weaker criterion"];
    repaired.tickets[0].verification_plan = []; repaired.tickets[0].file_budget = 100;
    return repaired;
  });
  const result = await state.create().handoff({ plan: state.plan });
  assert.equal(result.status, "handed_to_sprint_leader");
  assert.equal(state.requests.length, 1);
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].objective, "Publish API");
  assert.deepEqual(state.drafts[0].tickets.map((ticket) => ticket.priority), ["high", "high", "normal"]);
  assert.deepEqual(state.drafts[0].tickets[0].acceptance_criteria, ["Approved API works"]);
  assert.equal(state.drafts[0].tickets[0].verification_plan.length, 1);
  assert.equal(state.drafts[0].tickets[0].file_budget, 4);
  assert.equal(state.receipt.error_code, null);
  assert.equal((await state.create().handoff({ plan: state.plan })).replayed, true);
  assert.equal(state.requests.length, 1);
  assert.equal(state.events.some((event) => event.type === "agent.started"), false);
});

test("invalid replacement fails safely and a later owner retry can repair the same retained candidate", async () => {
  const state = fixture((attempt) => candidate(attempt === 1 ? [1, 1, 2] : ["high", "medium", "low"]));
  await assert.rejects(state.create().handoff({ plan: state.plan }), { code: "SPRINT_TICKET_PRIORITY_INVALID" });
  assert.equal(state.drafts.length, 0);
  assert.equal(state.requests.length, 1);
  assert.deepEqual(JSON.parse(state.receipt.generated_json).tickets.map((ticket) => ticket.priority), [1, 1, 2]);
  await state.create().handoff({ plan: state.plan });
  assert.equal(state.requests.length, 2);
  assert.equal(state.drafts.length, 1);
});

test("priority repair cannot bypass other schema failures or change ticket identity", async () => {
  const invalid = candidate(); invalid.human_plan.components = [{ name: "API" }];
  const state = fixture(() => candidate(["high", "high", "normal"]), invalid);
  await assert.rejects(state.create().handoff({ plan: state.plan }), /human_plan\/components/);
  assert.equal(state.drafts.length, 0);
  const changed = fixture(() => { const draft = candidate(["high", "high", "normal"]); draft.tickets[0].id = "TICKET-OTHER"; return draft; });
  await assert.rejects(changed.create().handoff({ plan: changed.plan }), { code: "SPRINT_PRIORITY_REPAIR_IDENTITY" });
  assert.equal(changed.drafts.length, 0);
});

test("direct ingestion still rejects numeric priority instead of weakening the schema", async () => {
  const state = fixture(() => candidate());
  const result = await state.orchestration.ingestAgentCompletion({ agentId: "LEADER-PRIORITY", message: { project_id: "PROJECT-PRIORITY", correlation_id: "CORR-PRIORITY", conversation_id: "CONV-PRIORITY" }, text: `\`\`\`json\n${JSON.stringify(candidate())}\n\`\`\`` });
  assert.equal(result.ingested, false);
  assert.match(result.error, /\/tickets\/0\/priority must be string/);
  assert.match(result.error, /must be equal to one of the allowed values/);
  assert.equal(state.drafts.length, 0);
});

test("valid persisted priorities on an operational retry do not request another SL generation", async () => {
  const state = fixture(() => { throw new Error("Valid priorities must replay the existing draft"); }, candidate(["high", "medium", "low"]));
  state.receipt.error_message = "Temporary storage failure";
  await state.create().handoff({ plan: state.plan });
  assert.equal(state.requests.length, 0);
  assert.equal(state.drafts.length, 1);
});

test("priority repair cannot remove a forbidden RUN request from the frozen draft", async () => {
  const draft = candidate(); draft.run = true;
  const state = fixture(() => candidate(["high", "high", "normal"]), draft);
  await assert.rejects(state.create().handoff({ plan: state.plan }), { code: "SPRINT_PLAN_EXECUTION_FORBIDDEN" });
  assert.equal(state.drafts.length, 0);
});

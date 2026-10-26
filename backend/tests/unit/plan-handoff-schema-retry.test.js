// Exercises approved outcome handoff through real Sprint schema admission and owner-triggered components repair.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";
import { repairSprintContractEvidence } from "../../src/modules/governance/sprint-contract-evidence.js";

const markdown = "# Plan: API\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Publish API | Approved API works | No RUN |\n\n## 6. Risks\nAssumption: review before execution.";

// Supplies a schema-valid Sprint whose component representation can be rejected independently of ticket coverage.
function candidate(components = ["API — validate requests"]) {
  return { id: "SPRINT-SCHEMA", roadmap_id: "ROADMAP-SCHEMA", project_id: "PROJECT-SCHEMA", objective: "Publish API", exit_criteria: ["Approved API works"],
    tickets: [{ id: "TICKET-SCHEMA-1", title: "Publish API", objective: "Publish API", implementation_type: ["backend"], file_budget: 4, outcome_refs: ["O1"], dependencies: [], acceptance_criteria: ["Approved API works"], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/plan-handoff-schema-retry.test.js" }] }],
    human_plan: { outcome: "Working API", in_scope: "API", out_of_scope: "UI", approach: "Validate requests", components, risks: [], assumptions: [], open_questions: [], evidence_refs: ["Approved plan"], acceptance_criteria: ["Approved API works"] } };
}

// Combines durable SQLite handoff receipts with the production ingestion validator and tracked immutable drafting.
async function fixture(context, requestPlan, storageFailures = 0, repairContractEvidence) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-schema-retry-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  context.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  const plan = { plan_id: "PLAN-SCHEMA", revision: 1, project_id: "PROJECT-SCHEMA", format: "markdown", sha256: "a".repeat(64), markdown };
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)", [plan.plan_id, 1, plan.project_id, "plan.md", plan.sha256, "summary.md", "b".repeat(64), new Date().toISOString()]);
  const requests = []; const drafts = []; const events = []; let registered = false; let storageAttempts = 0;
  const sprintRegistry = { get: () => registered ? { plan_id: "PLAN-CHILD", plan_revision: 1, plan_sha256: "child-digest", plan_path: "child.json" } : null };
  const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-SCHEMA" }) };
  const orchestration = createSprintOrchestrationService({
    sprintPlans: { getSprintById: () => null }, sprintRegistry, agentRoleResolver,
    // eslint-disable-next-line require-yield -- Any attempted execution must fail before yielding agent work.
    agentGateway: { stream: async function* () { throw new Error("Handoff must not RUN agents"); } },
    publisher: { publish: (event) => events.push(event) },
    draftPlan: async (draft) => {
      if (++storageAttempts <= storageFailures) throw new Error("Temporary storage failure");
      drafts.push(draft); registered = true;
      return { plan_id: "PLAN-CHILD", revision: 1, sha256: "child-digest", file_path: "child.json" };
    },
  });
  const service = createPlanHandoffService({ projectId: plan.project_id, database, sprintRegistry, agentRoleResolver,
    markdownPlanStore: { assertApproved: async () => plan },
    planStore: { assertExecutable: async () => ({}), getRevision: async () => ({ project_id: plan.project_id, sprint_id: "SPRINT-SCHEMA", sha256: "child-digest", file_path: "child.json", proposal_id: `${plan.plan_id}-R1-${plan.sha256}` }) },
    sprintPlanLeader: { repairContractEvidence, requestPlan: async (input) => { requests.push(input); return requestPlan(requests.length, input); } },
    sprintOrchestration: orchestration,
  });
  return { service, plan, requests, drafts, events, database, receipt: () => database.all("SELECT * FROM markdown_plan_handoffs WHERE plan_id=?", [plan.plan_id])[0] };
}

test("approved outcome handoff passes real schema without backend-added root properties", async (context) => {
  const state = await fixture(context, () => ({ ...candidate(), outcome_coverage: [{ legacy: true }] }));
  await state.service.handoff({ plan: state.plan });
  assert.equal(state.drafts.length, 1);
  assert.equal(state.drafts[0].outcome_coverage, undefined);
  assert.deepEqual(state.drafts[0].tickets[0].coverage.O1.guardrail_refs, ["No RUN"]);
  assert.deepEqual(state.drafts[0].tickets[0].coverage.O1.criterion_refs, ["Approved API works"]);
  assert.equal((await state.service.handoff({ plan: state.plan })).replayed, true);
  assert.equal(state.requests.length, 1);
});

test("owner retry repairs object components but cannot alter tickets or other review fields", async (context) => {
  const state = await fixture(context, (attempt, input) => {
    if (attempt === 1) return candidate([{ name: "API", purpose: "validate requests" }]);
    assert.match(input.brief, /Change ONLY human_plan.components/);
    const draft = candidate();
    draft.tickets[0].acceptance_criteria = ["Weakened scope"];
    draft.tickets[0].verification_plan = [];
    draft.human_plan.outcome = "Different work";
    draft.run = true;
    return draft;
  });
  await assert.rejects(state.service.handoff({ plan: state.plan }), (error) => error.message.includes("/human_plan/components/0 must be string"));
  assert.equal(state.drafts.length, 0);
  const frozen = JSON.parse(state.receipt().generated_json);
  await state.service.handoff({ plan: state.plan });
  const expected = structuredClone(frozen);
  expected.human_plan.components = ["API — validate requests"];
  assert.deepEqual(JSON.parse(state.receipt().generated_json), expected);
  assert.equal(state.requests.length, 2);
  assert.equal(state.drafts.length, 1);
  assert.equal((await state.service.handoff({ plan: state.plan })).replayed, true);
  assert.equal(state.requests.length, 2);
});

test("invalid components repair remains blocked with one provider call per owner attempt", async (context) => {
  const state = await fixture(context, () => candidate([{ name: "API" }]));
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(state.service.handoff({ plan: state.plan }), /components\/0 must be string/);
    assert.equal(state.requests.length, attempt);
    assert.equal(state.drafts.length, 0);
  }
});

test("components repair cannot drop component entries", async (context) => {
  const state = await fixture(context, (attempt) => candidate(attempt === 1 ? [{ name: "API" }, { name: "UI" }] : ["API"]));
  await assert.rejects(state.service.handoff({ plan: state.plan }), /must be string/);
  await assert.rejects(state.service.handoff({ plan: state.plan }), /must preserve every component/);
  assert.equal(state.drafts.length, 0);
  assert.equal(JSON.parse(state.receipt().generated_json).human_plan.components.length, 2);
});

test("unknown root properties remain rejected and diagnostics name the offending field", async (context) => {
  const state = await fixture(context, () => ({ ...candidate(), unexpected_scope: "unapproved" }));
  await assert.rejects(state.service.handoff({ plan: state.plan }), /must NOT have additional properties \(unexpected_scope\)/);
  assert.equal(state.drafts.length, 0);
});

test("storage failure retries a valid schema snapshot without regenerating", async (context) => {
  const state = await fixture(context, () => candidate(), 1);
  await assert.rejects(state.service.handoff({ plan: state.plan }), /Temporary storage failure/);
  await state.service.handoff({ plan: state.plan });
  assert.equal(state.requests.length, 1);
  assert.equal(state.drafts.length, 1);
});

// Repairs malformed widths before ingestion, retaining the frozen approved scope and replay behavior.
test("viewport schema failures use verification-only repair and pass real ingestion", async (context) => {
  for (const legacy of [false, true]) {
    const state = await fixture(context, (attempt, input) => {
      const draft = candidate();
      const repairing = legacy || attempt > 1;
      draft.tickets[0].verification_plan = [{ scenario_path: "ui/nextjs/tests/layout.browser.mjs", kind: "browser", criterion_ids: ["AC-1"], assertions: ["No horizontal overflow"], viewports: !repairing ? [{ width: 375, height: 812 }, "1440"] : [375, 1440] }];
      if (repairing) {
        assert.match(input.brief, /FINAL frozen acceptance_criteria/);
        draft.tickets[0].acceptance_criteria = ["Changed scope"];
        draft.human_plan.components = [{ name: "Changed component" }];
        draft.run = true;
      }
      return draft;
    });
    const frozen = candidate();
    frozen.tickets[0].verification_plan = [{ scenario_path: "ui/nextjs/tests/layout.browser.mjs", kind: "browser", criterion_ids: ["AC-1"], assertions: ["No horizontal overflow"], viewports: [{ width: 375, height: 812 }, "1440"] }];
    if (legacy) {
      state.database.run("INSERT INTO markdown_plan_handoffs(plan_id,revision,project_id,sha256,status,generated_json,error_code,error_message,updated_at) VALUES (?,?,?,?,?,?,?,?,?)", [state.plan.plan_id, 1, state.plan.project_id, state.plan.sha256, "candidate", JSON.stringify(frozen), "SPRINT_PLAN_HANDOFF_FAILED", "Sprint Leader returned invalid sprint plan: /tickets/0/verification_plan/0/viewports/0 must be integer", new Date().toISOString()]);
    }
    await state.service.handoff({ plan: state.plan });
    const finalSnapshot = JSON.parse(state.receipt().generated_json);
    frozen.tickets[0].coverage = finalSnapshot.tickets[0].coverage;
    const expected = structuredClone(frozen);
    expected.tickets[0].verification_plan[0].viewports = [375, 1440];
    assert.deepEqual(JSON.parse(state.receipt().generated_json), expected);
    assert.equal(state.drafts.length, 1);
    assert.equal(state.requests.length, legacy ? 1 : 2);
    assert.equal((await state.service.handoff({ plan: state.plan })).replayed, true);
    assert.equal(state.requests.length, legacy ? 1 : 2);
  }
});

// Leaves repeated malformed repairs blocked without coercing widths or dispatching an automatic retry loop.
test("invalid viewport repairs remain blocked across owner retries", async (context) => {
  const state = await fixture(context, () => {
    const draft = candidate();
    draft.tickets[0].verification_plan = [{ scenario_path: "ui/nextjs/tests/layout.browser.mjs", kind: "browser", criterion_ids: ["AC-1"], assertions: ["No overflow"], viewports: ["375"] }];
    return draft;
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await assert.rejects(state.service.handoff({ plan: state.plan }), (error) => error.code === "SPRINT_MARKDOWN_SCOPE" && error.message.includes("must be integer"));
    assert.equal(state.requests.length, attempt * 2);
    assert.equal(state.drafts.length, 0);
    assert.deepEqual(JSON.parse(state.receipt().generated_json).tickets[0].acceptance_criteria, ["Approved API works"]);
  }
});

// A pre-existing malformed checksum is repaired in place before real schema ingestion, without replanning or RUN.
test("retained contract checksum failure resumes the same draft through ingestion", async (context) => {
  const reads = [];
  const state = await fixture(context, () => assert.fail("Must reuse the retained draft"), 0, ({ plan }) => repairSprintContractEvidence(plan, { readFile: async (path) => {
    reads.push(path); return { path, sha256: `sha256:${"c".repeat(64)}` };
  } }));
  const frozen = candidate();
  frozen.tickets[0].execution_policy = { requires_existing_contract: true, contract_evidence: [{ path: "backend/src/example.js", sha256: "e".repeat(65), authority_quote: "Preserve the approved source contract" }] };
  state.database.run("INSERT INTO markdown_plan_handoffs(plan_id,revision,project_id,sha256,status,sprint_id,generated_json,error_code,error_message,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [state.plan.plan_id, 1, state.plan.project_id, state.plan.sha256, "generated", frozen.id, JSON.stringify(frozen), "SPRINT_PLAN_HANDOFF_FAILED", 'Sprint Leader returned invalid sprint plan: /tickets/0/execution_policy/contract_evidence/0/sha256 must match pattern "^[a-f0-9]{64}$"', new Date().toISOString()]);
  const result = await state.service.handoff({ plan: state.plan });
  assert.equal(result.status, "handed_to_sprint_leader");
  assert.deepEqual(reads, ["backend/src/example.js"]);
  assert.equal(state.requests.length, 0); assert.equal(state.drafts.length, 1);
  const persisted = JSON.parse(state.receipt().generated_json);
  const expected = structuredClone(frozen); expected.tickets[0].execution_policy.contract_evidence[0].sha256 = "c".repeat(64);
  expected.tickets[0].coverage = persisted.tickets[0].coverage;
  assert.deepEqual(persisted, expected);
  assert.equal(state.receipt().error_code, null); assert.equal(state.receipt().status, "completed");
  assert.equal((await state.service.handoff({ plan: state.plan })).replayed, true);
  assert.equal(reads.length, 1);
});

// Authorized read failures leave the legacy candidate intact and never fall back to invented hashes or replanning.
test("forbidden contract evidence cannot change a retained handoff", async (context) => {
  const state = await fixture(context, () => assert.fail("Must not replan"), 0, ({ plan }) => repairSprintContractEvidence(plan, { readFile: async () => {
    throw Object.assign(new Error("Forbidden source"), { code: "FILE_ROLE_FORBIDDEN" });
  } }));
  const frozen = candidate();
  frozen.tickets[0].execution_policy = { contract_evidence: [{ path: "backend/secrets/token.js", sha256: "invalid", authority_quote: "Keep the approved source scope" }] };
  state.database.run("INSERT INTO markdown_plan_handoffs(plan_id,revision,project_id,sha256,status,generated_json,updated_at) VALUES (?,?,?,?,?,?,?)", [state.plan.plan_id, 1, state.plan.project_id, state.plan.sha256, "candidate", JSON.stringify(frozen), new Date().toISOString()]);
  await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.deepEqual(JSON.parse(state.receipt().generated_json), frozen);
  assert.equal(state.requests.length, 0); assert.equal(state.drafts.length, 0);
});

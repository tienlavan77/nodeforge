// Reproduces description-field admission failures and proves canonical notes preserve frozen Sprint scope and strict verification.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSprintVerificationNotes } from "../../src/modules/governance/sprint-verification-notes.js";
import { assertTicketVerificationContract } from "../../src/modules/governance/ticket-verification-contract.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";
import { normalizeMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const markdown = "# Plan: Lifecycle\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Lifecycle | Approved lifecycle works | No RUN |\n\n## 6. Risks\nUnverified: live execution.";

// Supplies a minimal source-bound Sprint containing the observed legacy verification description.
function candidate(step = {}) {
  return { id: "SPRINT-LIFECYCLE", roadmap_id: "ROADMAP-LIFECYCLE", project_id: "PROJECT-A", objective: "Verify lifecycle", exit_criteria: ["Approved lifecycle works"],
    tickets: [{ id: "TICKET-MULTIPROJECT-A-R1-LIFECYCLE", title: "Lifecycle", objective: "Verify lifecycle", implementation_type: ["backend"], file_budget: 4, outcome_refs: ["O1"], dependencies: [], acceptance_criteria: ["Approved lifecycle works"],
      verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/sprint-verification-notes.test.js", description: "Verify the approved lifecycle", ...step }] }],
    human_plan: { outcome: "Working lifecycle", in_scope: "Lifecycle", out_of_scope: "UI", approach: "Verify lifecycle", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Approved plan"], acceptance_criteria: ["Approved lifecycle works"] } };
}

// Models durable handoff receipts while retaining real Sprint ingestion and schema admission without provider execution.
function fixture({ saved = false, step = {} } = {}) {
  const draft = candidate(step);
  const plan = { plan_id: "PLAN-LIFECYCLE", project_id: "PROJECT-A", revision: 1, sha256: "a".repeat(64), format: "markdown", markdown };
  const receipt = { plan_id: plan.plan_id, project_id: plan.project_id, revision: 1, sha256: plan.sha256, status: "started",
    ...(saved ? { status: "candidate", sprint_id: draft.id, generated_json: JSON.stringify(draft), error_code: "SPRINT_MARKDOWN_SCOPE", error_message: `Sprint ticket ${draft.tickets[0].id} has an invalid verification plan: Verification plan violates ticket schema: /verification_plan/0 must NOT have additional properties (description)` } : {}) };
  if (saved === "legacy") {
    receipt.error_code = "SPRINT_PLAN_HANDOFF_FAILED";
    receipt.error_message = "Sprint Leader returned invalid sprint plan: /tickets/0/verification_plan/0 must NOT have additional properties (description)";
  }
  const database = { transaction: (operation) => operation(), all: () => [{ ...receipt }], run: (sql, values) => {
    if (sql.startsWith("INSERT OR IGNORE")) return;
    let position = 0;
    for (const field of sql.match(/ SET (.+) WHERE /)[1].split(",")) {
      const [, name, value] = field.match(/^(\w+)=(\?|NULL)$/);
      receipt[name] = value === "NULL" ? null : values[position++];
    }
  } };
  const ingested = [];
  let registered = false;
  let calls = 0;
  const sprintRegistry = { get: () => registered ? { plan_id: "PLAN-CHILD", plan_revision: 1, plan_sha256: "child-digest", plan_path: "child.json" } : null };
  const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-A" }) };
  const orchestration = createSprintOrchestrationService({ sprintPlans: { getSprintById: () => null }, sprintRegistry, agentRoleResolver,
    agentGateway: { stream: () => { throw new Error("Must not RUN"); } }, publisher: { publish: () => {} },
    draftPlan: async (generated) => { ingested.push(generated); registered = true; return { plan_id: "PLAN-CHILD", revision: 1, sha256: "child-digest", file_path: "child.json" }; } });
  const create = () => createPlanHandoffService({ projectId: plan.project_id, database, sprintRegistry, agentRoleResolver,
    markdownPlanStore: { assertApproved: async () => plan }, planStore: { assertExecutable: async () => ({}), getRevision: async () => ({ project_id: plan.project_id, sprint_id: draft.id, sha256: "child-digest", file_path: "child.json", proposal_id: `${plan.plan_id}-R1-${plan.sha256}` }) },
    sprintPlanLeader: { requestPlan: async () => { calls++; return structuredClone(draft); } }, sprintOrchestration: orchestration });
  return { create, plan, receipt, draft, ingested, get calls() { return calls; } };
}

// Preserves both prose fields without touching executable checks or mutating the provider's draft.
test("verification description maps losslessly to notes and normalization is idempotent", () => {
  for (const notes of [undefined, "Existing notes", "Verify the approved lifecycle"]) {
    const draft = candidate(notes === undefined ? {} : { notes });
    const original = structuredClone(draft);
    assert.throws(() => assertTicketVerificationContract(draft.tickets[0]), { code: "TICKET_VERIFICATION_PLAN_INVALID" });
    const canonical = normalizeSprintVerificationNotes(draft);
    const step = canonical.tickets[0].verification_plan[0];
    assert.equal(step.description, undefined);
    assert.equal(step.notes, notes === "Existing notes" ? "Existing notes\nVerify the approved lifecycle" : "Verify the approved lifecycle");
    assert.equal(assertTicketVerificationContract(canonical.tickets[0]), true);
    assert.deepEqual(draft, original);
    assert.equal(normalizeSprintVerificationNotes(canonical), canonical);
    const expected = structuredClone(original);
    delete expected.tickets[0].verification_plan[0].description;
    expected.tickets[0].verification_plan[0].notes = step.notes;
    assert.deepEqual(canonical, expected);
  }
});

// Keeps unrelated extra fields, malformed values, missing tests, and missing criterion coverage blocked.
test("description compatibility does not relax the verification contract", () => {
  for (const patch of [{ unexpected: "field" }, { notes: {} }, { description: {} }, { description: " " }, { test_path: "" }, { criterion_ids: ["AC-2"] }, { kind: "browser", assertions: ["Check lifecycle"], viewports: ["375"] }]) {
    const canonical = normalizeSprintVerificationNotes(candidate(patch));
    assert.throws(() => assertTicketVerificationContract(canonical.tickets[0]), { code: "TICKET_VERIFICATION_PLAN_INVALID" });
  }
});

// Admits fresh and retained description-only drafts through production ingestion without another provider repair or RUN.
test("fresh and saved description-only handoffs admit canonical notes and replay exactly once", async () => {
  for (const saved of [false, true, "legacy"]) {
    const state = fixture({ saved });
    const result = await state.create().handoff({ plan: state.plan });
    assert.equal(result.status, "handed_to_sprint_leader");
    assert.equal(state.calls, saved ? 0 : 1);
    assert.equal(state.ingested.length, 1);
    const expected = normalizeMarkdownSprintScope(markdown, normalizeSprintVerificationNotes(state.draft));
    for (const [index, ticket] of expected.tickets.entries()) {
      for (const [field, value] of Object.entries(ticket)) assert.deepEqual(state.ingested[0].tickets[index][field], value);
    }
    assert.deepEqual(JSON.parse(state.receipt.generated_json).tickets, expected.tickets);
    assert.equal((await state.create().handoff({ plan: state.plan })).replayed, true);
    assert.equal(state.ingested.length, 1);
    assert.equal(state.calls, saved ? 0 : 1);
  }
});

// Prevents a corrected description from hiding another malformed field in an already rejected Sprint.
test("saved drafts with other verification defects remain blocked after description normalization", async () => {
  const state = fixture({ saved: true, step: { unexpected: "still invalid" } });
  await assert.rejects(state.create().handoff({ plan: state.plan }), (error) => error.code === "SPRINT_MARKDOWN_SCOPE" && error.message.includes("unexpected"));
  assert.equal(state.ingested.length, 0);
  assert.equal(state.calls, 1);
});

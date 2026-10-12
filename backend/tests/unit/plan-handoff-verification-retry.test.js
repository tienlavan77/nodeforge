// Verifies owner-triggered handoff retries repair rejected verification coverage without weakening criteria or replay safety.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { projectMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const approvedCriteria = Array.from({ length: 6 }, (_, index) => `Approved API requirement ${index + 1}`);
const ticketCriteria = Array.from({ length: 6 }, (_, index) => `Ticket-specific check ${index + 1}`);
const markdown = `# Plan: API coverage\n\n## 5. Outcomes\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | Publish API | ${approvedCriteria.join("; ")} | No RUN |\n\n## 6. Risks\nAssumption: review before execution.`;

// Supplies either the rejected six-criterion candidate or a fully mapped twelve-criterion repair.
function candidate(repaired = false) {
  const criteria = repaired ? [...ticketCriteria, ...approvedCriteria] : [...ticketCriteria];
  return { id: "SPRINT-COVERAGE", tickets: [{ id: "TICKET-COVERAGE-1", title: "Publish API", objective: "Preserve approved API scope", implementation_type: ["backend"], file_budget: 4, outcome_refs: ["O1"], dependencies: [], acceptance_criteria: criteria,
    verification_plan: [{ kind: "test", criterion_ids: criteria.map((_, index) => `AC-${index + 1}`), test_path: "backend/tests/unit/plan-handoff-verification-retry.test.js" }] }] };
}

// Uses migrated SQLite receipts and tracks provider and ingestion side effects independently.
async function fixture(testContext, requestPlan, ingestionFailures = 0) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-retry-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  testContext.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  const plan = { plan_id: "PLAN-COVERAGE", revision: 1, project_id: "PROJECT-A", format: "markdown", sha256: "a".repeat(64), markdown };
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "plan.md", plan.sha256, "summary.md", "b".repeat(64), new Date().toISOString()]);
  const requests = []; let ingests = 0; let registered = false; let approvals = 0;
  const service = createPlanHandoffService({
    projectId: "PROJECT-A", database,
    markdownPlanStore: { assertApproved: async () => { approvals++; return plan; } },
    planStore: {
      assertExecutable: async () => ({}),
      getRevision: async () => ({ project_id: "PROJECT-A", sprint_id: "SPRINT-COVERAGE", sha256: "child-digest", file_path: "child.json", proposal_id: `${plan.plan_id}-R1-${plan.sha256}` }),
    },
    sprintPlanLeader: { requestPlan: async (input) => { requests.push(input); return requestPlan(requests.length, input); } },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; if (ingests <= ingestionFailures) return { ingested: false, error: "Temporary storage failure" }; registered = true; return { ingested: true }; } },
    sprintRegistry: { get: () => registered ? { plan_id: "PLAN-CHILD", plan_revision: 1, plan_sha256: "child-digest", plan_path: "child.json" } : null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) },
  });
  return { service, plan, requests, get ingests() { return ingests; }, get approvals() { return approvals; },
    receipt: () => database.all("SELECT * FROM markdown_plan_handoffs WHERE plan_id=?", [plan.plan_id])[0] };
}

// Reproduces the exact AC-7 through AC-12 failure caused by approved criteria appended after SL numbering.
test("six mapped ticket criteria do not implicitly cover six appended approved criteria", () => {
  const draft = candidate(); const original = structuredClone(draft);
  assert.throws(() => projectMarkdownSprintScope(markdown, draft), (error) => error.code === "SPRINT_MARKDOWN_SCOPE" && error.message.includes("Verification plan does not cover AC-7, AC-8, AC-9, AC-10, AC-11, AC-12."));
  assert.deepEqual(draft, original);
});

// Repairs a retained invalid candidate on the next owner handoff, then replays without another provider dispatch.
test("Continue handoff repairs rejected coverage with final criteria and exact draft identity", async (context) => {
  const state = await fixture(context, (attempt) => candidate(attempt > 1));
  await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
  assert.equal(state.requests.length, 1);
  assert.equal(state.ingests, 0);
  assert.ok(state.receipt().generated_json);
  const result = await state.service.handoff({ plan: state.plan });
  assert.equal(result.status, "handed_to_sprint_leader");
  assert.equal(state.requests.length, 2);
  assert.equal(state.ingests, 1);
  assert.match(state.requests[1].brief, /Previously rejected Sprint draft/);
  assert.match(state.requests[1].brief, /TICKET-COVERAGE-1/);
  assert.match(state.requests[1].feedback, /Before numbering AC IDs/);
  assert.match(state.requests[1].feedback, /include the approved acceptance criteria verbatim/);
  assert.match(state.requests[1].feedback, /AC-7, AC-8, AC-9, AC-10, AC-11, AC-12/);
  const persisted = JSON.parse(state.receipt().generated_json);
  assert.deepEqual(persisted.tickets[0].acceptance_criteria, [...ticketCriteria, ...approvedCriteria]);
  assert.deepEqual(persisted.tickets[0].verification_plan[0].criterion_ids, Array.from({ length: 12 }, (_, index) => `AC-${index + 1}`));
  assert.equal(state.receipt().error_code, null);
  const replay = await state.service.handoff({ plan: state.plan });
  assert.equal(replay.replayed, true);
  assert.equal(state.requests.length, 2);
  assert.equal(state.ingests, 1);
  assert.equal(state.approvals, 3);
});

// Keeps coverage failures blocking and avoids an unbounded provider repair loop within a handoff.
test("a second incomplete SL response still fails without ingestion or automatic retries", async (context) => {
  const state = await fixture(context, () => candidate());
  for (let attempt = 1; attempt <= 2; attempt++) {
    await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
    assert.equal(state.requests.length, attempt);
    assert.equal(state.ingests, 0);
  }
});

// Preserves the repaired candidate on ingestion failures so storage retries do not call the provider again.
test("ingestion retry reuses a successfully repaired candidate", async (context) => {
  const state = await fixture(context, (attempt) => candidate(attempt > 1), 1);
  await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
  await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_PLAN_HANDOFF_FAILED" });
  assert.equal(state.requests.length, 2);
  const result = await state.service.handoff({ plan: state.plan });
  assert.equal(result.status, "handed_to_sprint_leader");
  assert.equal(state.requests.length, 2);
  assert.equal(state.ingests, 2);
});

// Refuses to silently replace a rejected draft's Sprint or ticket identities during verification repair.
test("verification repair cannot change Sprint or ticket IDs", async (context) => {
  for (const field of ["sprint", "ticket"]) {
    const state = await fixture(context, (attempt) => {
      const draft = candidate(attempt > 1);
      if (attempt > 1 && field === "sprint") draft.id = "SPRINT-OTHER";
      if (attempt > 1 && field === "ticket") draft.tickets[0].id = "TICKET-OTHER";
      return draft;
    });
    await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
    await assert.rejects(state.service.handoff({ plan: state.plan }), { code: "SPRINT_VERIFICATION_REPAIR_IDENTITY" });
    assert.equal(state.ingests, 0);
    assert.equal(JSON.parse(state.receipt().generated_json).id, "SPRINT-COVERAGE");
  }
});

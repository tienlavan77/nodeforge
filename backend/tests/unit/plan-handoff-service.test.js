// Verifies approved-plan handoff uses the real role profile and one durable receipt.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";

// Uses an isolated migrated database to test replay across service instances.
test("approved handoff persists generated Sprint Leader result and replays without a second dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-handoff-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  let calls = 0;
  let ingests = 0;
  const plan = { plan_id: "PLAN-A", revision: 1, project_id: "PROJECT-A", sha256: "digest", content: { objective: "Build", in_scope: "Backend", tickets: ["TICKET-A"], acceptance_criteria: ["Works"] } };
  database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,created_at) VALUES (?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "SPRINT-A", "plan.json", plan.sha256, new Date().toISOString()]);
  const dependencies = {
    projectId: "PROJECT-A", database,
    planStore: { assertExecutable: async () => plan },
    sprintPlanLeader: { requestPlan: async ({ agentId }) => { assert.equal(agentId, "LEADER-REAL"); calls++; return { id: "SPRINT-CHILD" }; } },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; return { ingested: true, sprint_id: "SPRINT-CHILD" }; } },
    sprintRegistry: { get: () => null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) }
  };
  try {
    const first = await createPlanHandoffService(dependencies).handoff({ plan, conversationId: "CONV-A" });
    const replay = await createPlanHandoffService(dependencies).handoff({ plan, conversationId: "CONV-A" });
    assert.equal(first.sprint_id, "SPRINT-CHILD");
    assert.equal(replay.replayed, true);
    assert.equal(calls, 1);
    assert.equal(ingests, 1);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Confirms failed ingestion retries the saved plan instead of asking the agent again.
test("ingestion retry reuses generated plan after a process failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-handoff-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plan = { plan_id: "PLAN-B", revision: 1, project_id: "PROJECT-A", sha256: "digest", content: { objective: "Build", in_scope: "Backend", tickets: ["TICKET-A"], acceptance_criteria: ["Works"] } };
  database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,created_at) VALUES (?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "SPRINT-B", "plan.json", plan.sha256, new Date().toISOString()]);
  let calls = 0;
  let ingests = 0;
  const dependencies = {
    projectId: "PROJECT-A", database,
    planStore: { assertExecutable: async () => plan },
    sprintPlanLeader: { requestPlan: async () => { calls++; return { id: "SPRINT-CHILD" }; } },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; return ingests === 1 ? { ingested: false, error: "Temporary failure" } : { ingested: true }; } },
    sprintRegistry: { get: () => null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) }
  };
  try {
    await assert.rejects(createPlanHandoffService(dependencies).handoff({ plan }), { code: "SPRINT_PLAN_HANDOFF_FAILED" });
    const retry = await createPlanHandoffService(dependencies).handoff({ plan });
    assert.equal(retry.status, "handed_to_sprint_leader");
    assert.equal(calls, 1);
    assert.equal(ingests, 2);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Blocks an execution-bearing Sprint Leader response before any downstream dispatch.
test("handoff refuses a RUN response without orchestration dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-handoff-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plan = { plan_id: "PLAN-NO-RUN", revision: 1, project_id: "PROJECT-A", sha256: "digest", content: { objective: "Build", in_scope: "Backend", tickets: ["TICKET-A"], acceptance_criteria: ["Works"] } };
  database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,created_at) VALUES (?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "SPRINT-A", "plan.json", plan.sha256, new Date().toISOString()]);
  let ingests = 0;
  const service = createPlanHandoffService({
    projectId: "PROJECT-A", database,
    planStore: { assertExecutable: async () => plan },
    sprintPlanLeader: { requestPlan: async () => ({ id: "SPRINT-NO-RUN", status: "RUN" }) },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; return { ingested: true }; } },
    sprintRegistry: { get: () => null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) }
  });
  try {
    await assert.rejects(service.handoff({ plan }), { code: "SPRINT_PLAN_EXECUTION_FORBIDDEN" });
    assert.equal(ingests, 0);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Confirms Sprint Leader receives the exact readable plan and supplies ticket IDs.
test("Markdown handoff sends approved bytes and requires Sprint Leader ticket IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-handoff-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plan = { plan_id: "PLAN-MD", revision: 1, project_id: "PROJECT-A", sha256: "a".repeat(64), markdown: "# Plan: reviewed API\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Return errors | — | ≤ 4 files | API returns errors |\n\n## 6. Risks\n", format: "markdown", decision: { decision_id: "DECISION-A" } };
  database.run("CREATE TABLE IF NOT EXISTS governance_roadmaps (sequence INTEGER PRIMARY KEY, version TEXT NOT NULL, roadmap_json TEXT NOT NULL)");
  database.run("INSERT INTO governance_roadmaps(version,roadmap_json) VALUES (?,?)", ["1", JSON.stringify({ id: "ROADMAP-A", project_id: "PROJECT-A" })]);
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "plan.md", plan.sha256, "summary.md", "b".repeat(64), new Date().toISOString()]);
  let brief = "";
  let ingests = 0;
  let calls = 0;
  let registered = false;
  const service = createPlanHandoffService({
    projectId: "PROJECT-A", database,
    planStore: { assertExecutable: async () => { throw new Error("JSON approval should not be used"); }, getRevision: async () => ({ proposal_id: `${plan.plan_id}-R1-${plan.sha256}` }) },
    markdownPlanStore: { assertApproved: async () => plan },
    sprintPlanLeader: { requestPlan: async (input) => { brief = input.brief; calls++; return { id: "SPRINT-MD", roadmap_id: null, human_plan: { evidence_refs: [{ reference: "Approved brief", observation: "Section 5" }] }, tickets: [{ id: "TICKET-MD-1", title: "Different title", objective: "Expand unrelated scope", implementation_type: ["frontend"], file_budget: 1, acceptance_criteria: ["Different criterion"], dependencies: ["TICKET-OTHER"], candidate_files: [{ path: "backend/src/api.js", role: "REFERENCE", reason: "Observed route" }], candidates_produced_by: "sprint_leader", candidates_produced_at: "2026-10-03T00:00:00Z" }] }; } },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; registered = true; database.run("INSERT INTO governance_roadmaps(version,roadmap_json) VALUES (?,?)", [`${ingests + 1}`, JSON.stringify({ id: "ROADMAP-A", project_id: "PROJECT-A", sprints: [{ id: "SPRINT-MD" }] })]); return { ingested: true }; } },
    sprintRegistry: { get: () => registered ? { plan_id: "PLAN-CHILD", plan_revision: 1 } : null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) }
  });
  try {
    await service.handoff({ plan });
    const generated = JSON.parse(database.all("SELECT generated_json FROM markdown_plan_handoffs WHERE plan_id=?", [plan.plan_id])[0].generated_json);
    assert.deepEqual(generated.tickets, [{ id: "TICKET-MD-1", title: "Fix API", objective: "Return errors", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["API returns errors"], dependencies: [] }]);
    assert.equal(generated.roadmap_id, "ROADMAP-A");
    assert.equal(generated.project_id, "PROJECT-A");
    assert.deepEqual(generated.human_plan.evidence_refs, ["Approved brief: Section 5"]);
    assert.match(brief, /# Plan: reviewed API/);
    assert.match(brief, new RegExp(plan.sha256));
    assert.equal(ingests, 1);
    assert.equal(calls, 1);
    database.run("INSERT INTO governance_roadmaps(version,roadmap_json) VALUES (?,?)", ["missing-projection", JSON.stringify({ id: "ROADMAP-A", project_id: "PROJECT-A", sprints: [] })]);
    const recovered = await service.handoff({ plan });
    assert.equal(recovered.sprint_id, "SPRINT-MD");
    assert.equal(ingests, 2);
    assert.equal(calls, 1);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Keeps malformed ticket identity from producing a durable Sprint draft.
test("Markdown handoff rejects duplicate ticket IDs before persistence", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-scope-retry-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plan = { plan_id: "PLAN-SCOPE", revision: 1, project_id: "PROJECT-A", sha256: "b".repeat(64), format: "markdown", markdown: "## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Return errors | — | ≤ 4 files | API returns errors |\n| 2 | Check UI | frontend | Display errors | Fix API | ≤ 2 files | UI displays errors |\n\n## 6. Risks\n" };
  database.run("CREATE TABLE IF NOT EXISTS governance_roadmaps (sequence INTEGER PRIMARY KEY, version TEXT NOT NULL, roadmap_json TEXT NOT NULL)");
  database.run("INSERT INTO governance_roadmaps(version,roadmap_json) VALUES (?,?)", ["1", JSON.stringify({ id: "ROADMAP-A", project_id: "PROJECT-A" })]);
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "plan.md", plan.sha256, "summary.md", "c".repeat(64), new Date().toISOString()]);
  let calls = 0;
  const service = createPlanHandoffService({ projectId: "PROJECT-A", database, planStore: { assertExecutable: async () => null }, markdownPlanStore: { assertApproved: async () => plan }, sprintPlanLeader: { requestPlan: async () => { calls += 1; return { id: "SPRINT-SCOPE", tickets: [{ id: "TICKET-SCOPE" }, { id: "TICKET-SCOPE" }] }; } }, sprintOrchestration: { ingestAgentCompletion: async () => { throw new Error("Invalid draft was dispatched."); } }, agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) } });
  try {
    await assert.rejects(service.handoff({ plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
    assert.equal(calls, 1);
    const receipt = database.all("SELECT generated_json,error_code FROM markdown_plan_handoffs WHERE plan_id=?", [plan.plan_id])[0];
    assert.equal(receipt.generated_json, null);
    assert.equal(receipt.error_code, "SPRINT_MARKDOWN_SCOPE");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

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

// Confirms Sprint Leader receives the exact readable plan and supplies ticket IDs.
test("Markdown handoff sends approved bytes and requires Sprint Leader ticket IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-handoff-"));
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const plan = { plan_id: "PLAN-MD", revision: 1, project_id: "PROJECT-A", sha256: "a".repeat(64), markdown: "# Plan: reviewed API\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Return errors | — | ≤ 4 files | API returns errors |\n\n## 6. Risks\n", format: "markdown", decision: { decision_id: "DECISION-A" } };
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision,project_id,file_path,sha256,summary_path,summary_sha256,created_at) VALUES (?,?,?,?,?,?,?,?)", [plan.plan_id, 1, "PROJECT-A", "plan.md", plan.sha256, "summary.md", "b".repeat(64), new Date().toISOString()]);
  let brief = "";
  let ingests = 0;
  let calls = 0;
  const service = createPlanHandoffService({
    projectId: "PROJECT-A", database,
    planStore: { assertExecutable: async () => { throw new Error("JSON approval should not be used"); } },
    markdownPlanStore: { assertApproved: async () => plan },
    sprintPlanLeader: { requestPlan: async (input) => { brief = input.brief; calls++; return { id: "SPRINT-MD", tickets: [{ id: "TICKET-MD-1", title: "Fix API", objective: calls === 1 ? "Expand unrelated scope" : "Return errors", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["API returns errors"] }] }; } },
    sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; return { ingested: true }; } },
    sprintRegistry: { get: () => null },
    agentRoleResolver: { resolveProfile: () => ({ agent_id: "LEADER-REAL" }) }
  });
  try {
    await assert.rejects(service.handoff({ plan }), { code: "SPRINT_MARKDOWN_SCOPE" });
    assert.equal(database.all("SELECT generated_json FROM markdown_plan_handoffs WHERE plan_id=?", [plan.plan_id])[0].generated_json, null);
    await service.handoff({ plan });
    assert.match(brief, /# Plan: reviewed API/);
    assert.match(brief, new RegExp(plan.sha256));
    assert.equal(ingests, 1);
    assert.equal(calls, 2);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

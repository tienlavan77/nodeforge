// Verifies completed plan handoffs survive readiness failure and reopen without a second decision, child or provider call.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { handoffApprovedRevision } from "../../src/application/plan-approval-action.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

test("completed receipt remains visible after readiness conflict and database reopen; retry reuses exact child", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-readiness-"));
  let database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const summary = "# Discussion Summary\nEvidence";
  const files = new Map([["summary.md", summary]]);
  const fileService = { readFile: async ({ path }) => files.get(path), atomicCreate: async ({ path, content }) => files.set(path, content), createLock: async () => ({ release: async () => {} }) };
  let providerCalls = 0; let ingests = 0; let blocked = true;
  try {
    let store = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const draft = await store.createRevision({ planId: "PLAN-A", markdown: "# Plan: Readiness recovery", summaryPath: "summary.md", summarySha256: digest(summary) });
    await store.decide({ planId: draft.plan_id, revision: 1, sha256: draft.sha256, decision: "approved", approverId: "OWNER" });
    const child = { plan_id: "PLAN-CHILD", revision: 1, project_id: "PROJECT-A", sprint_id: "SPRINT-A", file_path: "child.json", sha256: "b".repeat(64), proposal_id: `PLAN-A-R1-${draft.sha256}` };
    const now = new Date().toISOString();
    const childBytes = JSON.stringify(child);
    child.sha256 = digest(childBytes);
    files.set(child.file_path, childBytes);
    database.run("INSERT INTO plan_revisions(plan_id,revision,project_id,sprint_id,file_path,sha256,created_at) VALUES (?,?,?,?,?,?,?)", [child.plan_id, 1, child.project_id, child.sprint_id, child.file_path, child.sha256, now]);
    database.run("INSERT INTO sprint_registry(sprint_id,project_id,position,dependencies_json,status,plan_id,plan_revision,plan_path,plan_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)", ["SPRINT-A", "PROJECT-A", 1, "[]", "planned", child.plan_id, 1, child.file_path, child.sha256, now, now]);
    database.run("INSERT INTO markdown_plan_handoffs(plan_id,revision,project_id,sha256,status,sprint_id,updated_at) VALUES (?,?,?,?,?,?,?)", ["PLAN-A", 1, "PROJECT-A", draft.sha256, "completed", "SPRINT-A", now]);
    const registry = {
      get: () => database.all("SELECT * FROM sprint_registry WHERE sprint_id=?", ["SPRINT-A"])[0],
      setStatus: async ({ expectedVersion }) => {
        if (blocked) throw Object.assign(new Error("Dependency conflict"), { code: "SPRINT_DEPENDENCY_CONFLICT" });
        const row = registry.get(); assert.equal(expectedVersion, row.version);
        database.run("UPDATE sprint_registry SET status='ready',version=version+1 WHERE sprint_id=? AND version=?", ["SPRINT-A", expectedVersion]);
        return registry.get();
      }
    };
    const planStore = { getRevision: async () => child, assertExecutable: async () => child };
    // Reconstructs the production handoff/action boundary against the reopened durable receipt.
    const action = () => {
      const service = createPlanHandoffService({ projectId: "PROJECT-A", database, planStore, markdownPlanStore: store, sprintRegistry: registry,
        sprintPlanLeader: { requestPlan: async () => { providerCalls++; throw new Error("Must not regenerate completed child"); } },
        sprintOrchestration: { ingestAgentCompletion: async () => { ingests++; throw new Error("Must not ingest completed child"); } } });
      return handoffApprovedRevision({ projectId: "PROJECT-A", planId: "PLAN-A", revision: 1, sha256: draft.sha256, approverId: "OWNER", markdownPlanStore: store, planStore, sprintRegistry: registry, handoffApprovedPlan: (input) => service.handoff(input) });
    };
    await assert.rejects(action(), { code: "SPRINT_DEPENDENCY_CONFLICT" });
    assert.equal(database.all("SELECT status FROM markdown_plan_handoffs")[0].status, "completed");
    await database.close(); database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
    store = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const readback = await store.getRevision({ planId: "PLAN-A", revision: 1 });
    assert.equal(readback.status, "approved"); assert.equal(readback.handoff_status, "completed");
    assert.equal(readback.readiness_status, "pending"); assert.equal(readback.sprint_status, "planned");
    blocked = false;
    const result = await action();
    assert.equal(result.replayed, true); assert.equal(result.sprint_status, "ready");
    assert.equal(result.run_started, false); assert.equal(result.coder_dispatched, false); assert.equal(result.supervisor_dispatched, false);
    assert.equal((await store.getRevision({ planId: "PLAN-A", revision: 1 })).readiness_status, "established");
    assert.equal(providerCalls, 0); assert.equal(ingests, 0);
    assert.equal(database.all("SELECT * FROM markdown_plan_decisions").length, 1);
    assert.equal(database.all("SELECT * FROM plan_revisions").length, 1);
    assert.equal(database.all("SELECT * FROM markdown_plan_handoffs")[0].status, "completed");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

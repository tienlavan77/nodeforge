// Verifies exact owner policy approvals persist atomically in SQLite and cannot be inherited or replayed with changed choices.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { humanPlanMigration } from "../../src/infrastructure/sqlite/sprint-registry-migration.js";
import { derivedPlanMigration } from "../../src/infrastructure/sqlite/derived-plan-migration.js";
import { planDecisionSelectionsMigration } from "../../src/infrastructure/sqlite/plan-decision-selections-migration.js";
import { appendArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { sprintArchitectureDecisions } from "../../src/modules/governance/sprint-architecture-decisions.js";
import { createHash } from "node:crypto";

const PYTHON = `import json,sqlite3,sys
connection=sqlite3.connect(sys.argv[1])
connection.row_factory=sqlite3.Row
connection.execute('PRAGMA foreign_keys=ON')
result=[]
for operation in json.loads(sys.stdin.read()):
 cursor=connection.execute(operation['sql'],operation.get('params',[]))
 result.append([dict(row) for row in cursor.fetchall()] if operation.get('read') else {'changes':cursor.rowcount})
connection.commit()
print(json.dumps(result))
connection.close()
`;

// Runs actual plan SQL through project-local SQLite using Python when the SDK Node lacks node:sqlite.
function databaseAt(path) {
  let pending = null;
  const execute = (operations) => JSON.parse(execFileSync("python3", ["-c", PYTHON, path], { input: JSON.stringify(operations), encoding: "utf8" }));
  return {
    all: (sql, params = []) => execute([{ sql, params, read: true }])[0],
    run: (sql, params = []) => { if (pending) { pending.push({ sql, params }); return { changes: 1 }; } return execute([{ sql, params }])[0]; },
    transaction: (callback) => {
      assert.equal(pending, null);
      pending = [];
      try { const result = callback(); execute(pending); return result; }
      finally { pending = null; }
    }
  };
}

// Creates an isolated governance database and file authority, never the running project's records.
async function fixture(context) {
  const root = await mkdtemp(join(process.env.TMPDIR, "owner-plan-store-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const database = databaseAt(join(root, "index.db"));
  for (const sql of humanPlanMigration.statements) database.run(sql);
  database.run("ALTER TABLE plan_revisions ADD COLUMN source_path TEXT");
  database.run("ALTER TABLE plan_revisions ADD COLUMN source_sha256 TEXT");
  database.run("ALTER TABLE plan_decisions ADD COLUMN source_sha256 TEXT");
  database.run("CREATE TABLE markdown_plan_revisions(plan_id TEXT,revision INTEGER,PRIMARY KEY(plan_id,revision))");
  for (const sql of derivedPlanMigration.statements) database.run(sql);
  for (const sql of planDecisionSelectionsMigration.statements) database.run(sql);
  const fileService = createFileService({ projectRoot: root });
  const create = (markdownPlans = { assertApproved: async () => ({ file_path: "plan.md", sha256: "b".repeat(64), decision: { decision_id: "MD-OWNER" } }) }) => createHumanPlanStore({ projectId: "PROJECT-A", database, fileService, markdownPlans });
  const content = { objective: "Restore panels", outcome: "Panels restored", in_scope: "Coding", out_of_scope: "Backend", approach: "Registry", components: ["Coding"], tickets: ["TICKET-A"], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: ["SOURCE"], acceptance_criteria: ["Restored"], ticket_specs: [{ id: "TICKET-A", acceptance_criteria: ["Choose storage"], verification_plan: [{ kind: "human", criterion_ids: ["AC-1"], assertions: ["Owner chooses storage"] }] }], decision_requests: [{ id: "STORAGE", title: "Storage", reason: "Restore after reload", ticket_ids: ["TICKET-A"], criterion_ids: ["AC-1"], options: [{ id: "LOCAL", label: "Local", description: "Browser-local project metadata" }, { id: "SESSION", label: "Session", description: "Session scope only" }], recommended_option_id: "LOCAL" }] };
  return { root, database, fileService, create, content };
}

test("owner choices persist with immutable revision and idempotent replay rejects changed selections", async (context) => {
  const { create, content, database } = await fixture(context);
  const store = create();
  const plan = await store.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content });
  const input = { planId: plan.plan_id, revision: plan.revision, sha256: plan.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner", decisionId: "DECISION-A" };
  await assert.rejects(store.decide(input), { code: "PLAN_OWNER_DECISIONS_REQUIRED" });
  assert.equal(database.all("SELECT * FROM plan_decisions").length, 0);
  await store.decide({ ...input, selections: { STORAGE: "LOCAL" } });
  const reopened = create();
  const approved = await reopened.assertExecutable({ planId: "PLAN-A", revision: 1, sha256: plan.sha256 });
  assert.deepEqual(approved.decision.selections, { STORAGE: "LOCAL" });
  assert.equal(approved.decision.approver_id, "OWNER");
  await assert.doesNotReject(reopened.decide({ ...input, selections: { STORAGE: "LOCAL" } }));
  await assert.rejects(reopened.decide({ ...input, selections: { STORAGE: "SESSION" } }), { code: "PLAN_DECISION_EXISTS" });
  assert.equal(database.all("SELECT * FROM plan_decisions").length, 1);
  assert.equal(database.all("SELECT * FROM plan_decision_selections").length, 1);
  const revision = await reopened.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 1, content });
  assert.equal(revision.status, "awaiting_human_approval");
  assert.equal((await reopened.getRevision({ planId: "PLAN-A", revision: 2 })).decision, null);
  await assert.rejects(reopened.assertExecutable({ planId: "PLAN-A", revision: 2, sha256: revision.sha256 }), { code: "PLAN_APPROVAL_REQUIRED" });
});

test("approved Architecture source cannot auto-approve newly proposed Sprint policy choices", async (context) => {
  const { create, content, fileService, database } = await fixture(context);
  const source = "# approved architecture\n";
  const { createHash } = await import("node:crypto");
  const checksum = createHash("sha256").update(source).digest("hex");
  await fileService.atomicCreate({ path: "plan.md", content: source });
  const store = create({ assertApproved: async () => ({ file_path: "plan.md", sha256: checksum, decision: { decision_id: "MD-OWNER" } }) });
  const draft = await store.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content, sourcePath: "plan.md", sourceSha256: checksum });
  const inherited = await store.approveDerived({ planId: "PLAN-A", revision: 1, sha256: draft.sha256, markdownPlanId: "MD-A", markdownRevision: 1, markdownSha256: checksum });
  assert.equal(inherited.status, "awaiting_human_approval");
  assert.equal(database.all("SELECT * FROM derived_plan_approvals").length, 0);
  assert.equal((await store.getRevision({ planId: "PLAN-A", revision: 1 })).status, "awaiting_human_approval");
});

test("derived Sprint inherits exact Architecture policies and rejects changed or revoked parent authority", async (context) => {
  const { create, content, fileService, database } = await fixture(context);
  const source = appendArchitectureDecisions("# Architecture", { session_id: "CLARIFY-A", source_path: "input.md", source_sha256: "a".repeat(64), owner_id: "OWNER", confirmed_at: "2026-10-13T00:00:00Z", questions: [{ id: "STORAGE", title: "Storage", reason: "Recovery", options: [{ id: "LOCAL", label: "Local", description: "Project-local browser storage" }] }], selections: { STORAGE: "LOCAL" }, notes: {} });
  const checksum = createHash("sha256").update(source).digest("hex");
  await fileService.atomicCreate({ path: "plan.md", content: source });
  const parent = { plan_id: "MD-A", revision: 1, status: "approved", markdown: source, file_path: "plan.md", source_path: "input.md", source_sha256: "a".repeat(64), sha256: checksum, decision: { decision_id: "MD-OWNER", decision: "approved", sha256: checksum, approver_id: "OWNER" } };
  let revoked = false;
  const store = create({ assertApproved: async () => { if (revoked) throw Object.assign(new Error("Parent approval revoked"), { code: "PLAN_APPROVAL_REQUIRED" }); return parent; } });
  database.run("INSERT INTO markdown_plan_revisions(plan_id,revision) VALUES(?,?)", ["MD-A", 1]);
  const projected = { ...content, decision_requests: [], architecture_decisions: sprintArchitectureDecisions(parent), ticket_specs: [{ id: "TICKET-A", acceptance_criteria: ["Restored"], verification_plan: [{ kind: "browser", criterion_ids: ["AC-1"], assertions: ["Panel restores"] }] }] };
  const draft = await store.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content: projected, sourcePath: "plan.md", sourceSha256: checksum });
  const derived = await store.approveDerived({ planId: draft.plan_id, revision: 1, sha256: draft.sha256, markdownPlanId: "MD-A", markdownRevision: 1, markdownSha256: checksum });
  assert.equal(derived.status, "approved"); assert.equal(derived.decision, null); assert.deepEqual(derived.decision_requests, []);
  await store.assertExecutable({ planId: draft.plan_id, revision: 1, sha256: draft.sha256 });
  const forged = await store.createRevision({ planId: "PLAN-FORGED", sprintId: "SPRINT-FORGED", expectedRevision: 0, content: { ...projected, architecture_decisions: { ...projected.architecture_decisions, approver_id: "FORGED" } }, sourcePath: "plan.md", sourceSha256: checksum });
  await assert.rejects(store.approveDerived({ planId: forged.plan_id, revision: 1, sha256: forged.sha256, markdownPlanId: "MD-A", markdownRevision: 1, markdownSha256: checksum }), { code: "PLAN_DERIVATION_MISMATCH" });
  await assert.rejects(store.assertExecutable({ planId: forged.plan_id, revision: 1, sha256: forged.sha256 }), { code: "PLAN_APPROVAL_REQUIRED" });
  revoked = true;
  await assert.rejects(store.assertExecutable({ planId: draft.plan_id, revision: 1, sha256: draft.sha256 }), { code: "PLAN_APPROVAL_REQUIRED" });
});

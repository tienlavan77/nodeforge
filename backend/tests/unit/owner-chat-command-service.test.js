// Verifies owner planning commands remain immutable and execution-free.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";

const content = { objective: "Ship scoped work", outcome: "Reviewed plan", in_scope: "Feature", out_of_scope: "Other", approach: "Implement and verify", components: ["backend"], tickets: ["TICKET-A"], dependencies: [], risks: ["Drift"], assumptions: [], open_questions: [], evidence_refs: ["summary"], acceptance_criteria: ["Review"] };

test("summary and plan commands persist opaque references without running work", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-command-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
  const markdownPlans = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  await mkdir(join(root, "workflows/agents/architecture"), { recursive: true });
  await writeFile(join(root, "workflows/agents/architecture/README.md"), "# Khung kế hoạch\n\n## 1. Mục tiêu\n\n## 7. Nghiệm thu\n");
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, communications: { getByConversationId: () => [{ project_id: "PROJECT-A", sender: { id: "owner" }, payload: { text: "Build the feature" } }] }, planStore: plans, markdownPlanStore: markdownPlans });
  const summary = await service.execute({ text: "/summary", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: async () => "# Agreed summary\n\nOwner objective" });
  assert.equal(summary.execution_authorized, false);
  await assert.rejects(service.execute({ text: `/plan ${summary.summary_id}`, conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: async () => '{"plan_id":"PLAN-INVALID"}' }), { code: "ARCHITECTURE_PLAN_INVALID" });
  let prompt;
  const markdown = "# Plan: Owner objective\n\n## 1. Mục tiêu\n\nOwner objective\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | API change | backend | Fix API | — | ≤ 4 files | API works |\n\n## 6. Rủi ro\n\nNone\n\n## 7. Nghiệm thu\n\n- [ ] Reviewed";
  const draft = await service.execute({ text: `/plan ${summary.summary_id}`, conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: async (value) => { prompt = value; return markdown; } });
  assert.match(prompt, /Owner objective/);
  assert.match(prompt, /# Khung kế hoạch/);
  assert.match(prompt, /workflows\/agents\/architecture\/README\.md/);
  assert.equal(draft.status, "awaiting_human_approval");
  assert.equal(draft.text, `Đã tạo kế hoạch ${draft.plan_id}. Chờ duyệt.`);
  assert.ok(!draft.text.includes(draft.path));
  assert.match(draft.path, /\/ke-hoach-r1\.md$/);
  assert.equal(await readFile(join(root, draft.path), "utf8"), `${markdown}\n`);
  assert.deepEqual(plans.list(), []);
  await assert.rejects(service.execute({ text: `/approve ${draft.plan_id}`, project_id: "PROJECT-A", approvedOwnerId: "OWNER", approvalRevision: draft.revision, approvalSha256: "bad" }), { code: "PLAN_DECISION_STALE" });
  const outcomeMarkdown = "# Plan: Owner outcomes\n\n## 1. Mục tiêu\n\nOwner objective\n\n## 5. Outcomes\n\n| Mã | Outcome | Acceptance criteria | Guardrail |\n| --- | --- | --- | --- |\n| O1 | API works | HTTP returns canonical errors | — |\n\n## 6. Rủi ro\n\nNone\n\n## 7. Nghiệm thu\n\n- [ ] Reviewed";
  const outcomeDraft = await service.execute({ text: `/plan ${summary.summary_id}`, conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: async () => outcomeMarkdown });
  assert.equal(outcomeDraft.status, "awaiting_human_approval");
  assert.equal(await readFile(join(root, outcomeDraft.path), "utf8"), `${outcomeMarkdown}\n`);
  await database.close();
  await rm(root, { recursive: true, force: true });
});

test("approve hands off only an exact approved revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-command-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
  const draft = await plans.createRevision({ planId: "PLAN-A", sprintId: "SPRINT-A", expectedRevision: 0, content });
  await plans.decide({ planId: "PLAN-A", revision: 1, sha256: draft.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
  let called = false;
  let status = "planned";
  let readyCalls = 0;
  const sprintRegistry = { get: () => ({ status }), setStatus: async ({ status: next }) => { readyCalls++; status = next; return { status }; } };
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: plans, sprintRegistry, handoffApprovedPlan: async ({ plan }) => { called = true; return { sprint_id: plan.sprint_id, status: "handed_to_sprint_leader" }; } });
  await assert.rejects(service.execute({ text: "/approve PLAN-A", project_id: "PROJECT-A" }), { code: "PLAN_OWNER_UNAUTHORIZED" });
  const result = await service.execute({ text: "/approve PLAN-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER" });
  assert.equal(called, true);
  assert.equal(result.run_started, false);
  assert.equal(result.status, "handed_to_sprint_leader");
  assert.equal(result.sprint_status, "ready");
  assert.equal(readyCalls, 1);
  const replay = await service.execute({ text: "/approve PLAN-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER" });
  assert.equal(replay.sprint_status, "ready");
  assert.equal(readyCalls, 1);
  await database.close();
  await rm(root, { recursive: true, force: true });
});

// Keeps incomplete handoffs from making the Sprint executable.
test("approve waits for completed Sprint Leader handoff before marking ready", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-command-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true });
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
    const draft = await plans.createRevision({ planId: "PLAN-PENDING", sprintId: "SPRINT-PENDING", expectedRevision: 0, content });
    await plans.decide({ planId: draft.plan_id, revision: draft.revision, sha256: draft.sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" });
    const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: plans, sprintRegistry: { get: () => { throw new Error("Registry must not be read before handoff completes."); } }, handoffApprovedPlan: async () => ({ status: "handoff_in_progress" }) });
    const result = await service.execute({ text: "/approve PLAN-PENDING", approvedOwnerId: "OWNER" });
    assert.equal(result.status, "handoff_in_progress");
    assert.equal(result.sprint_status, undefined);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

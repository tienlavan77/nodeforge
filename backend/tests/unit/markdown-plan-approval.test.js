// Verifies owner approval of Markdown authorizes only its intact JSON Sprint projection.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

// Exercises the exact reviewed bytes, Sprint Leader ticket ID, and fail-closed source gate.
test("approved Markdown produces one executable JSON projection without a second owner decision", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-markdown-plan-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**"] });
    const markdownPlans = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService, markdownPlans });
    const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
    const summary = "# Scope\n";
    const summaryPath = ".forge/runtime/nf/summary/SUMMARY-A.md";
    await fileService.atomicWrite({ path: summaryPath, content: summary, replace: true });
    const parent = await markdownPlans.createRevision({ planId: "PLAN-PARENT", markdown: "# Plan: API\n\n## 1. Scope\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Fix API | — | ≤ 4 files | Pass |\n\n## 6. Risks\n\nNone\n\n## 7. Acceptance", summaryPath, summarySha256: createHash("sha256").update(summary).digest("hex") });
    const sprint = { id: "SPRINT-A", project_id: "PROJECT-A", objective: "Ship API", tickets: [{ id: "TICKET-API-1", title: "Fix API", objective: "Fix API", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["Pass"] }], human_plan: { outcome: "Working API", in_scope: "API", out_of_scope: "UI", approach: "Update API", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Summary"], acceptance_criteria: ["Pass"] } };
    const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore: plans, markdownPlanStore: markdownPlans, sprintRegistry: registry });
    const parentKey = `${parent.plan_id}-R${parent.revision}-${parent.sha256}`;
    await assert.rejects(draft(sprint, { approvedParentPlanKey: parentKey }), { code: "PLAN_APPROVAL_REQUIRED" });
    const command = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: plans, markdownPlanStore: markdownPlans, handoffApprovedPlan: async ({ plan }) => ({ status: "handed_to_sprint_leader", sprint_id: (await draft(sprint, { approvedParentPlanKey: `${plan.plan_id}-R${plan.revision}-${plan.sha256}` })).sprint_id }) });
    await assert.rejects(command.execute({ text: "/approve PLAN-PARENT", approvedOwnerId: "OWNER", approvalRevision: 1, approvalSha256: "wrong" }), { code: "PLAN_DECISION_STALE" });
    await command.execute({ text: "/approve PLAN-PARENT", approvedOwnerId: "OWNER", approvalRevision: 1, approvalSha256: parent.sha256 });
    const child = await plans.assertExecutable({ planId: "PLAN-SPRINT-A", revision: 1, sha256: plans.list()[0].sha256 });
    assert.equal(child.content.tickets[0], "TICKET-API-1");
    assert.equal(child.source_path, parent.file_path);
    assert.equal(child.source_sha256, parent.sha256);
    assert.equal(child.decision, null);
    assert.equal(child.approval_basis, "approved_markdown_projection");
    const router = createForgeV1Router({ planStore: plans, sprintRegistry: registry, expectedProjectId: "PROJECT-A", sprintOrchestrationService: { run: () => { throw new Error("Draft must remain blocked"); } } });
    const request = (method, route, body = {}) => {
      const input = Readable.from([JSON.stringify(body)]);
      input.headers = {};
      return router.route(method, new URL(`http://localhost/forge/v1${route}?project=PROJECT-A`), input);
    };
    await assert.rejects(request("POST", "/sprints/SPRINT-A/draft", { project_id: "PROJECT-A" }), { code: "SPRINT_REPLAN_REQUIRES_MARKDOWN" });
    const ready = await request("PUT", "/sprints/registry/SPRINT-A/status", { project_id: "PROJECT-A", status: "ready" });
    assert.equal(ready.body.status, "ready");
    await assert.rejects(plans.decide({ planId: child.plan_id, revision: 1, sha256: child.sha256, sourceSha256: child.source_sha256, decision: "approved", approverId: "OWNER", actorRole: "project_owner" }), { code: "PLAN_DERIVED_APPROVAL" });
    await fileService.atomicWrite({ path: summaryPath, content: "changed source", replace: true });
    await assert.rejects(plans.assertExecutable({ planId: child.plan_id, revision: 1, sha256: child.sha256 }), { code: "PLAN_SOURCE_MISMATCH" });
    await fileService.atomicWrite({ path: summaryPath, content: summary, replace: true });
    await fileService.atomicWrite({ path: parent.file_path, content: "tampered", replace: true });
    await assert.rejects(plans.assertExecutable({ planId: child.plan_id, revision: 1, sha256: child.sha256 }), { code: "PLAN_HASH_MISMATCH" });
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

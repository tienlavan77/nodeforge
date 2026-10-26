// Security tests for conversation-originated plan approval (O3/O4, approved sections 3.2.2-3.2.6, 6).
// Business purpose: proves Node approves ONLY the latest pending rendered revision of the current
// conversation and announces that revision's identity (AC-1), refuses approval without an
// authenticated owner (AC-2, AC-14), records the exact SHA-256 the owner reviewed (AC-3), rejects
// stale or superseded captured revisions/checksums before handoff (AC-4, AC-12), keeps the
// authenticated owner aligned with the recorded approver (AC-5), hands a completed approval to the
// Sprint Leader without starting RUN and marks the Sprint ready only through the registry (AC-6,
// AC-15, AC-16), replays duplicate deliveries onto one decision and one handoff (AC-9), fails closed
// when the retained SUMMARY/anchor snapshot no longer matches the reviewed bytes (AC-10, AC-13), and
// rejects cross-conversation targets (AC-10, AC-11).
// Technical description: drives the real SQLite Markdown plan store, real File Service, real
// conversation planning service and, for the replay path, the real plan handoff service with Sprint
// registry and draft persistence, so every assertion is executable behavior and persisted state.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createConversationPlanApprovalService } from "../../src/application/conversation-plan-approval-service.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const PLAN_JSON = JSON.stringify({
  title: "Approval plan", objective: "Approve only the rendered revision the owner reviewed.",
  background: "Owner created the plan from the conversation before approval routing existed.",
  scope: ["Approval security tests"], outcomes: [{ id: "O1", outcome: "Approval is conversation-scoped", acceptance_criteria: ["stale approval aborts"], guardrails: ["No RUN from approval"] }],
  evidence: [{ path: "backend/src/application/conversation-plan-approval-service.js", location: "L1", fact: "Node alone routes approval." }],
  assumptions: ["Owner reviews the rendered plan before approval."], constraints: ["Preserve handoff contracts"], risks: ["Stale approvals"], verification: "Focused unit tests."
});
const PATCH_JSON = JSON.stringify({ objective: "Approve the newest render only.", scope: ["Replacement scope"], outcomes: [{ id: "O1", outcome: "Approval targets r2", acceptance_criteria: ["r2 is the pending head"], guardrails: ["No RUN"] }] });
const NO_QUESTIONS = '{"questions":[]}';
// A canonical work-group plan document accepted by the unchanged Sprint scope gate on handoff.
const TABLE_PLAN_MARKDOWN = "# Plan: API\n\n## 1. Scope\n\nShip API.\n\n## 5. Tickets\n\n| Thứ tự | Nhóm việc | Implementation type | Mục tiêu | Phụ thuộc | Mutable-file budget | Acceptance criteria |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | Fix API | backend | Fix API | — | ≤ 4 files | Pass |\n\n## 6. Risks\n\nNone\n\n## 7. Acceptance";

// Applies the unchanged owner-facing Markdown gates so the real renderer bytes are accepted.
async function validateMarkdown(markdown) {
  if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw Object.assign(new Error("bad frame"), { code: "ARCHITECTURE_PLAN_INVALID" });
  if (!/discovery complete/i.test(markdown) || !/assumption|unverified|unknown|uncertain/i.test(markdown)) throw Object.assign(new Error("incomplete discovery"), { code: "DISCOVERY_INCOMPLETE" });
  readMarkdownSprintScope(markdown);
}

// Creates real plan storage, a scripted planner head and a fresh approval service per handoff stub.
async function fixture(answers = [NO_QUESTIONS, PLAN_JSON, PATCH_JSON], approval = {}) {
  const root = await mkdtemp(join(tmpdir(), "conversation-approval-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const state = { index: 0 };
  const requestArchitecture = async () => answers[Math.min(state.index++, answers.length - 1)];
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions: createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService }), requestArchitecture });
  const calls = { handoffs: 0, announced: 0, stateAtAnnounce: null };
  const approvedOwnerId = "OWNER";
  const decisions = () => database.all("SELECT * FROM markdown_plan_decisions");
  const service = createConversationPlanApprovalService({ projectId: "PROJECT-A", markdownPlanStore, sprintRegistry: { get: () => ({ status: "planned" }), setStatus: async ({ status }) => ({ status }) }, handoffApprovedPlan: async () => { calls.handoffs++; return { status: "handed_to_sprint_leader", sprint_id: "SPRINT-SEC", ...(approval.handoff ?? {}) }; }, announceApprovalIdentity: async (info) => { calls.announced++; calls.stateAtAnnounce = { decisions: decisions().length, handoffs: calls.handoffs, info }; }, ...approval });
  const close = async () => { await database.close(); await rm(root, { recursive: true, force: true }); };
  return { database, fileService, markdownPlanStore, planning, calls, service, decisions, approvedOwnerId, close };
}

// Proves the newest pending render is selected and announced with its full identity.
test("approval selects the latest pending revision of the current conversation and announces it", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const updated = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(updated.revision, 2);
    const pending = await f.service.selectPendingRevision({ conversationId: "CONV-A" });
    assert.equal(pending.plan_id, created.plan_id);
    assert.equal(pending.revision, 2, "r1 is superseded; only the newest render stays approvable");
    assert.equal(pending.sha256, updated.sha256);
    const result = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: updated.revision, approvalSha256: updated.sha256 });
    assert.match(result.announcement, new RegExp(`plan ${created.plan_id} revision 2`));
    assert.ok(result.announcement.includes(updated.sha256), "the announced identity carries the exact reviewed SHA-256");
    assert.match(result.announcement, /CONV-A/);
    assert.equal(f.calls.announced, 1, "the selected identity is announced through the owner-visible channel exactly once");
    assert.equal(f.calls.stateAtAnnounce.decisions, 0, "the announcement lands before any decision row exists");
    assert.equal(f.calls.stateAtAnnounce.handoffs, 0, "the announcement lands before any handoff happens");
    assert.equal(f.calls.stateAtAnnounce.info.revision, 2);
    assert.equal(f.calls.stateAtAnnounce.info.sha256, updated.sha256);
    assert.equal(f.decisions().length, 1);
    assert.equal(f.decisions()[0].sha256, updated.sha256, "the decision records the exact rendered checksum");
    assert.equal(f.decisions()[0].decision, "approved");
    assert.equal(f.decisions()[0].approver_id, f.approvedOwnerId);
  } finally { await f.close(); }
});

// Rejects approval before any decision or handoff when the owner is not authenticated.
test("approval without an authenticated owner fails with PLAN_OWNER_UNAUTHORIZED and no side effects", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A" }), { code: "PLAN_OWNER_UNAUTHORIZED" });
    assert.equal(f.decisions().length, 0, "no decision row may exist for an unauthenticated approval");
    assert.equal(f.calls.handoffs, 0);
  } finally { await f.close(); }
});

// Closes the approval window for any captured revision older than the newest render.
test("approving a superseded or altered revision aborts with PLAN_APPROVAL_STALE", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: 1, approvalSha256: "f".repeat(64) }), { code: "PLAN_APPROVAL_STALE" });
    assert.equal(f.decisions().length, 0, "a stale identity never records a decision");
    assert.equal(f.calls.handoffs, 0);
    const updated = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: created.revision, approvalSha256: created.sha256 }), { code: "PLAN_APPROVAL_STALE" }, "the captured r1 identity is superseded by r2");
    assert.equal(f.decisions().length, 0);
    assert.notEqual(updated.sha256, created.sha256);
  } finally { await f.close(); }
});

// Keeps the recorded approver aligned with the authenticated owner on repeat deliveries.
test("a different approver on an already-approved revision fails with PLAN_APPROVAL_OWNER_MISMATCH", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: 1, approvalSha256: created.sha256 });
    assert.equal(f.decisions().length, 1);
    const before = f.calls.handoffs;
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OTHER", approvalRevision: 1, approvalSha256: created.sha256 }), { code: "PLAN_APPROVAL_OWNER_MISMATCH" });
    assert.equal(f.decisions().length, 1, "the mismatched approver adds no decision row");
    assert.equal(f.calls.handoffs, before, "the mismatched approver adds no handoff");
  } finally { await f.close(); }
});

// Hands off a successful approval without any execution authority.
test("a successful approval hands to Sprint Leader, marks the Sprint ready and never starts RUN", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const result = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: 1, approvalSha256: created.sha256 });
    assert.equal(result.status, "handed_to_sprint_leader");
    assert.equal(result.run_started, false, "plan approval never starts RUN");
    assert.equal(result.coder_dispatched, false);
    assert.equal(result.supervisor_dispatched, false);
    assert.equal(result.sprint_status, "ready");
    assert.equal(result.plan_id, created.plan_id);
    assert.equal(result.sha256, created.sha256);
    assert.equal(f.calls.handoffs, 1);
  } finally { await f.close(); }
});

// Replays duplicate approval deliveries through the real handoff gate onto one decision/handoff.
test("duplicate approval delivery reuses one decision and never repeats handoff", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-approval-replay-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
    const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService, markdownPlans: markdownPlanStore });
    const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
    database.run("CREATE TABLE IF NOT EXISTS governance_roadmaps (sequence INTEGER PRIMARY KEY, version TEXT NOT NULL, roadmap_json TEXT NOT NULL)");
    const summary = "# Scope\n";
    const summaryPath = ".forge/runtime/nf/summary/SUMMARY-R.md";
    await fileService.atomicWrite({ path: summaryPath, content: summary, replace: true });
    const parent = await markdownPlanStore.createRevision({ planId: "PLAN-REPLAY", conversationId: "CONV-A", markdown: TABLE_PLAN_MARKDOWN, summaryPath, summarySha256: createHash("sha256").update(summary).digest("hex") });
    const sprint = { id: "SPRINT-DUP", roadmap_id: "ROADMAP-DUP", project_id: "PROJECT-A", objective: "Ship API", exit_criteria: ["Pass"], tickets: [{ id: "TICKET-DUP-1", title: "Fix API", objective: "Fix API", implementation_type: ["backend"], file_budget: 4, acceptance_criteria: ["Pass"], verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/conversation-plan-approval.test.js" }] }], human_plan: { outcome: "API", in_scope: "API", out_of_scope: "UI", approach: "Update", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Summary"], acceptance_criteria: ["Pass"] } };
    const draft = createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore: plans, markdownPlanStore, sprintRegistry: registry });
    const agentRoleResolver = { resolveProfile: () => ({ agent_id: "LEADER-DUP" }) };
    const orchestration = createSprintOrchestrationService({ sprintPlans: { getSprintById: () => { throw new Error("legacy reader must not run"); } }, sprintPlanStore: { save: () => { throw new Error("legacy projection must not be written"); } }, sprintRegistry: registry, draftPlan: draft, agentRoleResolver, agentGateway: { async stream() { throw new Error("legacy agent stream must not run"); } }, publisher: { publish: () => {} } });
    let leaderCalls = 0;
    const handoff = createPlanHandoffService({ projectId: "PROJECT-A", database, planStore: plans, markdownPlanStore, sprintRegistry: registry, sprintOrchestration: orchestration, agentRoleResolver, sprintPlanLeader: { requestPlan: async () => { leaderCalls++; return structuredClone(sprint); } } });
    const announcements = [];
    const service = createConversationPlanApprovalService({ projectId: "PROJECT-A", markdownPlanStore, sprintRegistry: registry, handoffApprovedPlan: (input) => handoff.handoff(input), announceApprovalIdentity: async (info) => { announcements.push({ revision: info.revision, sha256: info.sha256, decisionsWritten: database.all("SELECT * FROM markdown_plan_decisions").length, handoffsWritten: database.all("SELECT * FROM markdown_plan_handoffs").length }); } });
    const first = await service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: parent.revision, approvalSha256: parent.sha256 });
    assert.equal(first.status, "handed_to_sprint_leader");
    assert.equal(first.replayed, false);
    assert.deepEqual(announcements[0], { revision: parent.revision, sha256: parent.sha256, decisionsWritten: 0, handoffsWritten: 0 }, "the fresh approval announces the captured identity before the first decision row or handoff record exists");
    assert.equal(first.sprint_status, "ready", "the fresh approval marks the registered Sprint ready");
    assert.equal(database.all("SELECT * FROM markdown_plan_handoffs").length, 1);
    assert.equal(database.all("SELECT * FROM markdown_plan_decisions").length, 1);
    const replay = await service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: parent.revision, approvalSha256: parent.sha256 });
    assert.equal(replay.replayed, true);
    assert.equal(replay.sprint_id, "SPRINT-DUP");
    assert.equal(replay.status, "handed_to_sprint_leader", "the replay reports the same completed handoff");
    assert.equal(replay.run_started, false, "even a replayed approval never starts RUN");
    assert.equal(database.all("SELECT * FROM markdown_plan_decisions").length, 1, "a duplicate delivery never creates a second decision");
    assert.equal(leaderCalls, 1, "a duplicate delivery never repeats the Sprint Leader handoff");
    assert.equal((await markdownPlanStore.getRevision({ planId: parent.plan_id, revision: 1 })).handoff_status, "completed");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Fails closed when the retained snapshot behind the rendered revision is altered.
test("an altered source snapshot cannot authorize handoff even after a matching decision", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const snapshotPath = `.forge/runtime/nf/plans/${created.plan_id}/summary-r1.md`;
    const summary = await f.fileService.readFile({ path: snapshotPath });
    await f.fileService.atomicWrite({ path: snapshotPath, content: "tampered source snapshot", replace: true });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: 1, approvalSha256: created.sha256 }), { code: "PLAN_SOURCE_MISMATCH" });
    assert.equal(f.calls.handoffs, 0, "a broken SUMMARY snapshot gate blocks handoff even though the rendered Markdown bytes still match");
    await f.fileService.atomicWrite({ path: snapshotPath, content: summary, replace: true });
    const restored = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: f.approvedOwnerId, approvalRevision: 1, approvalSha256: created.sha256 });
    assert.equal(restored.status, "handed_to_sprint_leader");
    assert.equal(restored.sha256, created.sha256);
    assert.equal(createHash("sha256").update(summary).digest("hex"), created.source_summary_sha256, "the retained snapshot keeps its exact reviewed checksum");
  } finally { await f.close(); }
});

// Keeps approval inside the conversation that rendered the plan.
test("a cross-conversation target has no pending revision and cannot authorize approval", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-B", approvedOwnerId: f.approvedOwnerId }), { code: "PLAN_APPROVAL_PENDING_MISSING" });
    assert.equal(f.decisions().length, 0);
    assert.equal(f.calls.handoffs, 0);
  } finally { await f.close(); }
});

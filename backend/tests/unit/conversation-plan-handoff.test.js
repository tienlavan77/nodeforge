// Exercises conversation planning through approval, Sprint admission and derived
// execution authority using real stores. Policy input and canonical JSON are
// intentionally distinct; retry must preserve both without rewriting approval,
// requesting another AM draft or silently granting RUN.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createSprintPlanDraftPersistence } from "../../src/modules/governance/sprint-plan-draft-persistence.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createPlanHandoffService } from "../../src/application/plan-handoff-service.js";
import { createSprintOrchestrationService } from "../../src/application/sprint-orchestration-service.js";
import { appendArchitectureDecisions, readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { sprintArchitectureDecisions } from "../../src/modules/governance/sprint-architecture-decisions.js";
import { architectureSessionFromRecord, renderArchitecturePlanMarkdown } from "../../src/modules/governance/architecture-plan-json.js";
import { retainConversationPlanSource } from "../../src/modules/governance/conversation-plan-source.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
import { formatHumanReadableHandoffBrief, parseAmReviewVerdict, parseSePlanCritique } from "../../src/application/am-se-handoff-service.js";
import { createConversationCrudService } from "../../src/application/conversation-crud-service.js";

const planJSON = JSON.stringify({ title: "Conversation plan", objective: "Deliver API", background: "Owner conversation",
  scope: ["API"], outcomes: [{ id: "O1", outcome: "Deliver API", acceptance_criteria: ["Works"], guardrails: ["Preserve source"] }],
  evidence: [{ path: "backend/src/api.js", location: "L1", fact: "Existing API" }], assumptions: ["Owner reviews the plan"], constraints: [], risks: [], verification: "Focused API test" });
const questions = [{ id: "STORAGE", title: "Storage", reason: "Owner policy", options: [{ id: "LOCAL", label: "Local", description: "Local storage" }, { id: "SERVER", label: "Server", description: "Server storage" }] }];

// Supplies a real-schema Sprint that preserves the approved outcome and makes
// provider dispatch visible independently from persistence and replay.
function sprintCandidate() {
  return { id: "SPRINT-A", roadmap_id: "ROADMAP-A", project_id: "PROJECT-A", objective: "Deliver API", exit_criteria: ["Works"],
    tickets: [{ id: "TICKET-API", title: "Deliver API", objective: "Deliver API", implementation_type: ["backend"], file_budget: 4, outcome_refs: ["O1"], dependencies: [], acceptance_criteria: ["Works"],
      verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: "backend/tests/unit/conversation-plan-handoff.test.js" }] }],
    human_plan: { outcome: "Working API", in_scope: "API", out_of_scope: "UI", approach: "Preserve approved API scope", components: ["API"], risks: [], assumptions: [], open_questions: [], evidence_refs: ["Approved Architecture plan"], acceptance_criteria: ["Works"] } };
}

// Builds production planning, approval and Sprint services over isolated files
// and SQLite, keeping the old intake-bound record so existing approvals are tested.
async function fixture(context, { confirmed = false, updated = false, human = false, invalidRepair = false, grouped = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "conversation-handoff-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  context.after(async () => { await database.close(); await rm(root, { recursive: true, force: true }); });
  if (grouped) {
    await mkdir(join(root, ".forge/runtime/nf"), { recursive: true });
    await writeFile(join(root, ".forge/runtime/nf/nf-runtime-layout.json"), JSON.stringify({ version: 1, layout: "grouped", status: "ready" }));
  }
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**"] });
  await fileService.atomicCreate({ path: "backend/src/api.js", content: "// Existing API\n" });
  const markdownPlans = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const plans = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService, markdownPlans });
  const registry = createSprintRegistry({ projectId: "PROJECT-A", database, plans });
  const sessions = createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService });
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore: markdownPlans, sessions, validateMarkdown: async () => {},
    requestArchitecture: async (prompt) => prompt.startsWith("Architecture clarification discovery") ? JSON.stringify({ questions: confirmed ? questions : [] }) : prompt.startsWith("Architecture plan update") ? '{"objective":"Deliver updated API"}' : planJSON });
  let result = await planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
  if (confirmed) {
    const session = await planning.saveClarificationChoices({ sessionId: result.session_id, expectedVersion: 1, sourceSha256: result.source_summary_sha256, selections: { STORAGE: "SERVER" } });
    result = await planning.continuePlan({ sessionId: session.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: session.version, sourceSha256: session.source_sha256 });
  }
  const original = result;
  if (updated) result = await planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
  const identity = { planId: result.plan_id, revision: result.revision, sha256: result.sha256 };
  await markdownPlans.decide({ ...identity, decision: "approved", approverId: "OWNER" });
  const parent = await markdownPlans.getRevision(identity);
  const agentRoleResolver = { resolveProfile: () => ({ agent_id: "SL-A" }) };
  const draftPlan = createSprintPlanDraftPersistence({ projectId: "PROJECT-A", planStore: plans, markdownPlanStore: markdownPlans, sprintRegistry: registry });
  const orchestration = createSprintOrchestrationService({ sprintPlans: { getSprintById: () => null }, sprintRegistry: registry, draftPlan, agentRoleResolver,
    agentGateway: { stream: async function* () { yield assert.fail("Handoff must never RUN an agent"); } }, publisher: { publish: () => {} } });
  let calls = 0;
  const service = () => createPlanHandoffService({ projectId: "PROJECT-A", database, planStore: plans, markdownPlanStore: markdownPlans, sprintRegistry: registry,
    agentRoleResolver, sprintOrchestration: orchestration, sprintPlanLeader: { requestPlan: async () => {
      calls++;
      const candidate = sprintCandidate();
      if (human && (calls === 1 || invalidRepair)) candidate.tickets[0].verification_plan = [{ kind: "human", criterion_ids: ["AC-1"], notes: "Independent security review needs deployment evidence" }];
      return candidate;
    } } });
  return { root, database, fileService, markdownPlans, plans, registry, identity, parent, original, service, calls: () => calls };
}

for (const options of [{}, { confirmed: true }, { confirmed: true, updated: true }, { updated: true }, { confirmed: true, updated: true, grouped: true }]) {
  test(`conversation plan handoff preserves approved source and policies ${JSON.stringify(options)}`, async (context) => {
    const f = await fixture(context, options);
    const before = await f.fileService.readFile({ path: f.parent.file_path });
    const approval = f.parent.decision;
    const result = await f.service().handoff({ plan: f.parent, conversationId: "CONV-A" });
    assert.equal(result.status, "handed_to_sprint_leader");
    const binding = f.registry.get("SPRINT-A");
    const child = await f.plans.assertExecutable({ planId: binding.plan_id, revision: binding.plan_revision, sha256: binding.plan_sha256 });
    assert.equal(child.content.architecture_decisions.parent_sha256, f.parent.sha256);
    assert.deepEqual(child.content.architecture_decisions.decisions, readArchitectureDecisions(before).decisions);
    assert.equal(child.source_path, f.parent.file_path);
    assert.equal(child.source_sha256, f.parent.sha256);
    assert.equal(child.approval_basis, "approved_markdown_projection");
    assert.equal(binding.status, "planned");
    assert.equal((await f.service().handoff({ plan: f.parent })).replayed, true);
    assert.equal(f.calls(), 1);
    assert.equal(f.plans.list().length, 1);
    assert.equal(f.database.all("SELECT * FROM markdown_plan_decisions").length, 1);
    assert.equal(await f.fileService.readFile({ path: f.parent.file_path }), before);
    assert.deepEqual((await f.markdownPlans.getRevision(f.identity)).decision, approval);
    if (options.updated) assert.equal((await f.markdownPlans.getRevision({ planId: f.original.plan_id, revision: 1 })).markdown, f.original.markdown);
  });
}

// Simulates a retained receipt written by the previous source-equality gate.
// Recovery consumes that draft once and preserves its approved parent unchanged.
test("retained failed handoff resumes the saved Sprint without another SL generation", async (context) => {
  const f = await fixture(context, { confirmed: true });
  f.database.run("INSERT INTO markdown_plan_handoffs(plan_id,revision,project_id,sha256,status,sprint_id,generated_json,error_code,error_message,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [f.parent.plan_id, f.parent.revision, "PROJECT-A", f.parent.sha256, "generated", "SPRINT-A", JSON.stringify(sprintCandidate()), "SPRINT_PLAN_HANDOFF_FAILED", "Sprint policies require the exact approved Architecture source.", new Date().toISOString()]);
  await f.service().handoff({ plan: f.parent });
  const receipt = f.database.all("SELECT * FROM markdown_plan_handoffs")[0];
  assert.equal(receipt.status, "completed");
  assert.equal(receipt.error_code, null);
  assert.equal(f.calls(), 0);
  assert.equal(f.plans.list()[0].revision, 1);
});

// A manual prerequisite emitted under the old contradictory prompt must reach
// SL verification repair without changing approval, scope, identities or coverage.
test("human verification prerequisite is repaired once before Sprint ingestion", async (context) => {
  const f = await fixture(context, { human: true });
  await f.service().handoff({ plan: f.parent });
  assert.equal(f.calls(), 2);
  const child = await f.plans.getRevision({ planId: "PLAN-SPRINT-A", revision: 1 });
  assert.deepEqual(child.content.ticket_specs[0].acceptance_criteria, ["Works"]);
  assert.equal(child.content.ticket_specs[0].verification_plan[0].kind, "test");
  assert.equal(child.status, "approved");
  assert.equal(f.database.all("SELECT * FROM markdown_plan_decisions").length, 1);
});

// Invalid corrections stay blocked rather than being relabeled as governance,
// waived by parent approval, or retried indefinitely inside a handoff request.
test("unrepaired human prerequisite retains actionable verification diagnostics", async (context) => {
  const f = await fixture(context, { human: true, invalidRepair: true });
  await assert.rejects(f.service().handoff({ plan: f.parent }), (error) => error.code === "SPRINT_MARKDOWN_SCOPE" && /invalid verification plan:.*kind human/.test(error.message));
  assert.equal(f.calls(), 2);
  assert.equal(f.registry.list().length, 0);
  assert.equal(f.plans.list().length, 0);
});

// Checks that distinct source identities are not a blanket permission to trust
// arbitrary Markdown, copied verification flags or modified immutable input bytes.
test("conversation policy source validation rejects missing, changed and unverified inputs", async (context) => {
  const f = await fixture(context, { confirmed: true });
  assert.throws(() => sprintArchitectureDecisions(f.parent), { code: "ARCHITECTURE_DECISIONS_INVALID" });
  const approved = await f.markdownPlans.assertApproved(f.identity);
  assert.equal(sprintArchitectureDecisions(approved).decisions[0].option_id, "SERVER");
  assert.throws(() => sprintArchitectureDecisions({ ...approved }), { code: "ARCHITECTURE_DECISIONS_INVALID" });
  approved.source_sha256 = "b".repeat(64);
  assert.throws(() => sprintArchitectureDecisions(approved), { code: "ARCHITECTURE_DECISIONS_INVALID" });
  const record = readArchitectureDecisions(f.parent.markdown);
  await f.fileService.atomicWrite({ path: record.source_path, content: "changed intake", replace: true });
  await assert.rejects(f.markdownPlans.assertApproved(f.identity), { code: "PLAN_SOURCE_MISMATCH" });
  await f.fileService.deleteFile({ path: record.source_path });
  await assert.rejects(f.markdownPlans.assertApproved(f.identity), { code: "PLAN_SOURCE_MISSING" });
  assert.equal(f.registry.list().length, 0);
});

// An approved hash still needs the exact canonical plan and a local policy source;
// approving an inconsistent or cross-project artifact cannot manufacture that chain.
test("canonical reconstruction rejects altered content and foreign decision provenance", async (context) => {
  const f = await fixture(context, { confirmed: true });
  const record = readArchitectureDecisions(f.parent.markdown);
  const anchor = await retainConversationPlanSource({ fileService: f.fileService, planId: f.parent.plan_id, revision: 2, canonicalBytes: planJSON });
  const base = renderArchitecturePlanMarkdown({ plan: JSON.parse(planJSON), planId: f.parent.plan_id, revision: 2, sourceSha256: anchor.sha256 });
  const foreign = appendArchitectureDecisions(base, {
    ...architectureSessionFromRecord(record), source_path: record.source_path.replace(f.parent.plan_id, "PLAN-FOREIGN") });
  const created = await f.markdownPlans.createRevision({ planId: f.parent.plan_id, expectedRevision: 1, markdown: foreign, summaryPath: anchor.path, summarySha256: anchor.sha256, conversationId: "CONV-A" });
  const foreignIdentity = { planId: created.plan_id, revision: created.revision, sha256: created.sha256 };
  await f.markdownPlans.decide({ ...foreignIdentity, decision: "approved", approverId: "OWNER" });
  await assert.rejects(f.markdownPlans.assertApproved(foreignIdentity), { code: "ARCHITECTURE_DECISIONS_INVALID" });
  await assert.rejects(f.markdownPlans.assertApproved(f.identity), { code: "PLAN_APPROVAL_REQUIRED" });
  const nextAnchor = await retainConversationPlanSource({ fileService: f.fileService, planId: f.parent.plan_id, revision: 3, canonicalBytes: planJSON });
  const nextBase = renderArchitecturePlanMarkdown({ plan: JSON.parse(planJSON), planId: f.parent.plan_id, revision: 3, sourceSha256: nextAnchor.sha256 });
  const inconsistent = await f.markdownPlans.createRevision({ planId: f.parent.plan_id, expectedRevision: 2,
    markdown: appendArchitectureDecisions(nextBase.replace("Deliver API", "Unrelated work"), architectureSessionFromRecord(record)),
    summaryPath: nextAnchor.path, summarySha256: nextAnchor.sha256, conversationId: "CONV-A" });
  const inconsistentIdentity = { planId: inconsistent.plan_id, revision: 3, sha256: inconsistent.sha256 };
  await f.markdownPlans.decide({ ...inconsistentIdentity, decision: "approved", approverId: "OWNER" });
  await assert.rejects(f.markdownPlans.assertApproved(inconsistentIdentity), { code: "PLAN_HASH_MISMATCH" });
});

test("markdown_file planning, Phase 1 AM-SE plan critique (ALIGNED & DISCUSS), and Phase 2 SL / SE handoff", async (context) => {
  const f = await fixture(context);
  await f.fileService.atomicWrite({ path: "docs/spec.md", content: "# Feature Spec\nImplement unified planning.\n", replace: true });
  const busMessages = [];
  const conversations = createConversationCrudService({ database: f.database });
  const commandService = createOwnerChatCommandService({
    projectId: "PROJECT-A", fileService: f.fileService, planStore: f.plans, markdownPlanStore: f.markdownPlans,
    sprintRegistry: f.registry, handoffApprovedPlan: ({ plan }) => f.service().handoff({ plan }),
    conversationCrudService: conversations,
    bus: { send: (msg) => { busMessages.push(msg); return msg; } },
    agentRoleResolver: { resolveProfile: (role) => role === "system_engineer" ? { agent_id: "se-1", role: "system_engineer" } : { agent_id: "am-1", role: "architecture_manager" } }
  });

  // 1. Markdown file + automatic SL handoff -> creates r1, runs 1-round AM-SE critique ([CRITIQUE: ALIGNED]), auto-approves, and marks Sprint ready.
  const slPrompts = [];
  const slSeCalls = [];
  const slRes = await commandService.execute({
    text: "tạo kế hoạch từ docs/spec.md, giao việc cho SL", conversationId: "CONV-SL", project_id: "PROJECT-A", approvedOwnerId: "OWNER",
    requestArchitecture: async (prompt) => { slPrompts.push(prompt); return prompt.startsWith("Architecture clarification") ? '{"questions":[]}' : planJSON; },
    requestSystemEngineer: async (req) => { slSeCalls.push(req); return "SE đã khảo sát code và đồng thuận với kế hoạch.\n[CRITIQUE: ALIGNED]"; }
  });
  assert.match(slPrompts[0], /Feature Spec/);
  assert.equal(slSeCalls.length, 1);
  assert.equal(slSeCalls[0].phase, "plan_critique");
  assert.equal(slRes.status, "paused");
  assert.equal(slRes.reason, "PLAN_APPROVAL_REQUIRED");
  assert.equal(slRes.delivery_target, "sl");
  assert.equal(slSeCalls.length, 1);
  assert.equal(slRes.sprint_id, undefined);

  // 2. Markdown file + automatic SE handoff -> 2-round AM-SE critique ([CRITIQUE: DISCUSS] -> [CRITIQUE: ALIGNED]), then implementation REVISE -> PASS.
  let reviewRound = 0;
  const seCalls = [];
  const seRes = await commandService.execute({
    text: "tạo kế hoạch từ docs/spec.md, giao việc cho SE", conversationId: "CONV-ARCH", project_id: "PROJECT-A", approvedOwnerId: "OWNER",
    requestArchitecture: async (prompt) => {
      if (prompt.startsWith("Architecture clarification")) return '{"questions":[]}';
      if (prompt.startsWith("Architecture plan generation")) return planJSON;
      if (prompt.startsWith("Architecture plan critique response")) return "AM giải đáp điểm phản biện của SE và thống nhất giữ cấu trúc O1.";
      reviewRound += 1;
      return reviewRound === 1 ? "Vòng 1: Cần bổ sung kiểm thử cho O1.\n[VERDICT: REVISE]" : "Nghiệm thu hoàn tất: O1 đạt đầy đủ.\n[VERDICT: PASS]";
    },
    requestReviewer: async ({ round }) => `RV đã kiểm tra code và test vòng ${round}.\n[VERDICT: PASS]`,
    requestSystemEngineer: async (req) => {
      seCalls.push(req);
      if (req.phase === "plan_critique") {
        return req.critiqueRound === 1 ? "Cần làm rõ ranh giới O1.\n[CRITIQUE: DISCUSS]" : "Đã rõ, SE đồng thuận.\n[CRITIQUE: ALIGNED]";
      }
      return `Báo cáo SE vòng ${req.round}`;
    }
  });
  assert.equal(seRes.delivery_target, "se");
  assert.equal(seRes.phase, "plan_critique");
  assert.equal(seRes.status, "paused");
  assert.equal(seRes.reason, "PLAN_APPROVAL_REQUIRED");
  assert.match(seRes.text, /chờ Owner approval; SE chưa được giao thực thi/);
  assert.doesNotMatch(seRes.text, /undefined/);
  assert.equal(seRes.revision, 1);
  assert.equal(seCalls.length, 2);
  assert.equal(seCalls[0].phase, "plan_critique");
  assert.equal(seCalls[1].phase, "plan_critique");
  assert.equal(seCalls[0].linkedConversationId, "CONV-ARCH");
  assert.match(seCalls[0].prompt, /## Trình bày & Phản biện kế hoạch kiến trúc/);
  assert.doesNotMatch(seCalls[0].prompt, /"acceptance_criteria":\s*\[/);
  assert.ok(!seCalls.some((call) => call.phase === "implementation"), "SE cannot implement before Owner approval");
  assert.ok(busMessages.some((m) => m.conversation_id === "CONV-ARCH" && m.payload.linked_conversation_id === `CONV-SE-${seRes.plan_id}`));
  assert.ok(busMessages.every((m) => !m.conversation_id?.startsWith("CONV-SE-")), "handoff dialogue stays in its source conversation");
  const seConversations = conversations.list({ projectId: "PROJECT-A", agentId: "se-1" });
  assert.equal(seConversations.length, 0, "internal SE session does not create a sidebar conversation");
  conversations.ensure({ id: `CONV-SE-${seRes.plan_id}`, project_id: "PROJECT-A", agent_id: "se-1", title: "Legacy handoff" });
  assert.equal(conversations.list({ projectId: "PROJECT-A", agentId: "se-1" }).length, 0, "legacy internal sessions stay out of the sidebar");
  assert.ok(conversations.get(`CONV-SE-${seRes.plan_id}`), "legacy history remains accessible for audit");

  // 3. AM -> SE -> RV -> SE -> RV -> AM -> SE -> RV -> AM full cycle with independent Reviewer (RV) gate.
  const cycleSeCalls = [];
  const cycleRvCalls = [];
  const cycleAmCalls = [];
  const cycleBusMessages = [];
  const cycleCommandService = createOwnerChatCommandService({
    projectId: "PROJECT-A",
    fileService: f.fileService,
    planStore: f.plans,
    markdownPlanStore: f.markdownPlans,
    handoffApprovedPlan: (args) => f.service().handoff(args),
    sprintRegistry: f.registry,
    bus: { send: (msg) => { cycleBusMessages.push(msg); return msg; } },
    conversationCrudService: conversations,
    agentRoleResolver: {
      resolveProfile: (role) => {
        if (role === "system_engineer") return { agent_id: "se-1", role: "system_engineer" };
        if (role === "reviewer") return { agent_id: "rv-1", role: "reviewer" };
        if (role === "architecture_manager") return { agent_id: "am-1", role: "architecture_manager" };
        return { agent_id: "SL-A", role: "sprint_lead" };
      }
    }
  });

  const cycleRes = await cycleCommandService.execute({
    text: "tạo kế hoạch từ docs/spec.md, giao việc cho SE",
    conversationId: "CONV-ARCH-RV",
    project_id: "PROJECT-A",
    approvedOwnerId: "OWNER",
    requestArchitecture: async (prompt) => {
      if (prompt.startsWith("Architecture clarification discovery")) return '{"questions":[]}';
      if (prompt.startsWith("Architecture acceptance review")) {
        cycleAmCalls.push(prompt);
        return cycleAmCalls.length === 1
          ? "AM nhận thấy cần bổ sung thêm 1 kiểm thử biên cho O1.\n[VERDICT: REVISE]"
          : "AM nghiệm thu đạt toàn bộ O1 sau khi RV đã xác nhận.\n[VERDICT: PASS]";
      }
      return planJSON;
    },
    requestSystemEngineer: async (req) => {
      cycleSeCalls.push(req);
      if (req.phase === "plan_critique") return "SE đồng thuận phương án.\n[CRITIQUE: ALIGNED]";
      return `SE hoàn thành thực thi vòng ${req.round}.`;
    },
    requestReviewer: async (req) => {
      cycleRvCalls.push(req);
      return req.round === 1
        ? "RV phát hiện thiếu test cho trường hợp lỗi ở vòng 1.\n[VERDICT: REVISE]"
        : `RV xác nhận code và test vòng ${req.round} đạt chuẩn.\n[VERDICT: PASS]`;
    }
  });

  assert.equal(cycleRes.status, "paused");
  assert.equal(cycleRes.reason, "PLAN_APPROVAL_REQUIRED");
  assert.equal(cycleRvCalls.length, 0, "RV cannot review before Owner approval");
  assert.equal(cycleAmCalls.length, 0, "AM cannot accept before Owner approval");
  assert.ok(cycleSeCalls.every((call) => call.phase === "plan_critique"), "SE cannot implement before Owner approval");
  assert.equal(cycleRes.history.filter((entry) => entry.phase === "implementation").length, 0);
  assert.ok(!cycleBusMessages.some((m) => m.message_type === "reviewer.message.received"), "no synthetic Reviewer result before Owner approval");
  assert.match(formatHumanReadableHandoffBrief(JSON.parse(planJSON), { planId: "PLAN-1", sourceKind: "markdown_file", sourceFilePath: "docs/spec.md" }), /docs\/spec\.md/);
  assert.equal(parseAmReviewVerdict("Cannot confirm PASS").verdict, null);
  assert.equal(parseAmReviewVerdict("Please REVISE the checks").verdict, null);
  assert.equal(parseAmReviewVerdict("Evidence pending.\n[VERDICT: PASS]\nAdditional text").verdict, null);
  assert.equal(parseAmReviewVerdict("\n[VERDICT: PASS]").verdict, null);
  const parsedVerdict = parseAmReviewVerdict("Khi RV trả `[VERDICT: REVISE]` hoặc `[VERDICT: PASS]` đều hoạt động đúng.\nKết luận: đạt yêu cầu.\n`[VERDICT: PASS]`");
  assert.equal(parsedVerdict.verdict, "PASS");
  assert.doesNotMatch(parsedVerdict.cleanText, /`\[VERDICT: PASS\]`$/);
  assert.equal(parseSePlanCritique("Phân tích hoàn tất.\n**[CRITIQUE: ALIGNED]**").status, "ALIGNED");

  // 3. Conversation SL handoff retry phrase ("giao lại cho SL") resumes/handoffs the latest plan in the conversation without regenerating the plan.
  assert.equal(commandService.isCommand("chạy giao lại cho SL giúp đi!"), true);
  assert.equal(commandService.isCommand("/handoff"), true);
  const retryRes = await commandService.execute({ text: "chạy giao lại cho SL giúp đi!", conversationId: "CONV-SL", project_id: "PROJECT-A", approvedOwnerId: "OWNER" });
  assert.equal(retryRes.status, "handed_to_node");
  assert.equal(retryRes.sprint_id, "SPRINT-A");
  assert.equal(retryRes.sprint_status, "ready");
});

// Conversation-originated Architecture Plan creation through the unchanged store and gates.
// Business purpose: proves an owner creates a schema-validated plan from ordinary
// conversation without typing a path, hash or command (AC-1), that Node invokes
// Architecture for JSON only, validates it, generates the revision SHA-256 itself and
// stores a per-revision source snapshot (AC-2), returns plan identity plus rendered
// Markdown in the same conversation (AC-3) in awaiting_human_approval state (AC-4) with
// run_started false (AC-5), keeps deterministic trigger routing compatible with the
// transport intent whitelist (AC-6), and guarantees a mixed create/update-plus-approve
// message never approves (AC-10, AC-11, AC-12, AC-13).
// Technical description: exercises the real SQLite markdown plan store, real File
// Service and the durable clarification session store against a scripted Architecture
// provider, so every assertion is executable behavior and persisted state rather than
// source-text matching.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";
import { assertNoMixedPlanningApproval, detectIdeaSynthesisTrigger, detectPlanApproveTrigger, detectPlanCreateTrigger, detectPlanUpdateTrigger, isConversationPlanMessage, isIdeaSummaryResponse, parseConversationPlanCreateTrigger } from "../../src/modules/governance/conversation-plan-trigger.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

const PLAN_JSON = JSON.stringify({
  title: "Conversation plan",
  objective: "Deliver owner-reviewed planning from conversation.",
  background: "Owner asked Node to plan the work discussed in the conversation.",
  scope: ["Backend planning modules and focused tests"],
  outcomes: [{ id: "O1", outcome: "Plan created from conversation", acceptance_criteria: ["plan_id and sha256 returned", "Markdown rendered in the same conversation"], guardrails: ["No UI change", "No approval authority change"] }],
  evidence: [{ path: "backend/src/application/owner-chat-command-service.js", location: "L1", fact: "Planning commands stay execution-free." }],
  assumptions: ["Owner reviews the rendered plan before approval."],
  constraints: ["Preserve the existing Markdown storage and handoff contracts"],
  risks: ["Provider may return prose instead of schema-valid JSON"],
  verification: "Focused unit tests plus Node commit-bound verification."
});

// Creates a command service wired to real plan storage plus one readable evidence path.
async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "conversation-plan-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/owner-chat-command-service.js", content: "// evidence target for the plan gate\n", replace: true });
  const communications = createAgentCommunicationStore({ database, fileService, storageRoot: join(root, ".forge/runtime/communications") });
  const planStore = createHumanPlanStore({ projectId: "PROJECT-A", database, fileService });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, communications, planStore, markdownPlanStore, ...extra });
  return { database, fileService, communications, planStore, markdownPlanStore, root, service, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Scripts one Architecture provider that answers clarification and plan requests separately.
function provider(planAnswer = PLAN_JSON) {
  const prompts = [];
  const requestArchitecture = async (prompt) => { prompts.push(prompt); return prompt.startsWith("Architecture clarification discovery") ? '{"questions":[]}' : planAnswer; };
  return { prompts, requestArchitecture };
}

test("O1: detectIdeaSynthesisTrigger and isIdeaSummaryResponse recognize natural idea synthesis requests and agent idea headings while respecting fences, questions, and explicit overrides", () => {
  assert.ok(detectIdeaSynthesisTrigger("Hãy tổng hợp các trao đổi trên thành một ý tưởng."));
  assert.ok(detectIdeaSynthesisTrigger("Please summarize the discussion above as an idea."));
  assert.equal(detectIdeaSynthesisTrigger("tạo kế hoạch từ các ý tưởng"), null);
  assert.equal(detectIdeaSynthesisTrigger("Có nên tổng hợp thành ý tưởng không?"), null);
  assert.equal(detectIdeaSynthesisTrigger("> tổng hợp thành một ý tưởng"), null);
  assert.equal(detectIdeaSynthesisTrigger("```text\ntổng hợp thành một ý tưởng\n```"), null);
  assert.equal(isIdeaSummaryResponse({ ownerText: "Hãy tổng hợp các trao đổi trên thành một ý tưởng.", agentText: "Nội dung tóm tắt." }), true);
  assert.equal(isIdeaSummaryResponse({ ownerText: "Trao đổi bình thường", agentText: "## Ý tưởng: Tối ưu bộ đệm truy vấn\nChi tiết giải pháp." }), true);
  assert.equal(isIdeaSummaryResponse({ ownerText: "Normal chat", agentText: "**Idea:** Add retry backoff to worker" }), true);
  assert.equal(isIdeaSummaryResponse({ ownerText: "Normal chat", agentText: "Ordinary reply without idea marker" }), false);
  assert.equal(isIdeaSummaryResponse({ ownerText: "Hãy tổng hợp thành một ý tưởng", agentText: "## Ý tưởng: X", explicitIdea: false }), false);
});

test("O2: parseConversationPlanCreateTrigger recognizes marked_ideas commands in Vietnamese and English with delivery_target (none | sl | se) and preserves filters and mixed-approval guards", () => {
  const cases = [
    ["tạo kế hoạch từ các ý tưởng", "marked_ideas", "none"],
    ["tạo kế hoạch từ ý tưởng đã đánh dấu", "marked_ideas", "none"],
    ["tạo kế hoạch từ các ý tưởng, giao việc cho SE", "marked_ideas", "se"],
    ["tạo kế hoạch từ các ý tưởng và giao cho SL", "marked_ideas", "sl"],
    ["tạo kế hoạch kiến trúc từ các ý tưởng đã đánh dấu và bàn giao cho System Engineer!", "marked_ideas", "se"],
    ["create a plan from the marked ideas", "marked_ideas", "none"],
    ["create plans from marked ideas, hand off to SE", "marked_ideas", "se"],
    ["generate architecture plans from the ideas and assign to Sprint Leader", "marked_ideas", "sl"],
    ["/plan-ideas se", "marked_ideas", "se"],
    ["/plan-marked-ideas sl", "marked_ideas", "sl"]
  ];
  for (const [input, expectedKind, expectedTarget] of cases) {
    const parsed = parseConversationPlanCreateTrigger(input);
    assert.ok(parsed, `Expected trigger match for: ${input}`);
    assert.equal(parsed.source_kind, expectedKind, input);
    assert.equal(parsed.delivery_target, expectedTarget, input);
    assert.equal(parsed.source_path, null, input);
    assert.equal(isConversationPlanMessage(input), true, input);
  }
  for (const ignored of [
    "tạo kế hoạch từ các ý tưởng?",
    "> tạo kế hoạch từ các ý tưởng, giao việc cho SE",
    "```md\ntạo kế hoạch từ các ý tưởng, giao việc cho SE\n```",
    "create a plan from the marked ideas?"
  ]) {
    assert.equal(parseConversationPlanCreateTrigger(ignored), null, ignored);
  }
  assert.throws(
    () => assertNoMixedPlanningApproval("tạo kế hoạch từ các ý tưởng\nduyệt kế hoạch"),
    (error) => error.code === "PLAN_APPROVAL_MIXED"
  );
});

test("O3: createFromConversation with marked_ideas fails closed when no ideas exist, groups follow-up discussions into each marked idea, creates independent plans, and runs per-plan handoff", async () => {
  const handoffCalls = [];
  const env = await fixture({
    amSeHandoffService: {
      startHandoff: async ({ plan, intake, deliveryTarget }) => {
        handoffCalls.push({ plan_id: plan.plan_id, revision: plan.revision, sha256: plan.sha256, source_kind: intake.source_kind, idea_message_id: intake.idea_message_id, delivery_target: deliveryTarget });
        return {
          plan_id: plan.plan_id,
          revision: plan.revision,
          sha256: plan.sha256,
          status: deliveryTarget === "sl" ? "handed_to_sprint_leader" : "completed",
          sprint_id: deliveryTarget === "sl" ? `SPRINT-${plan.plan_id}` : undefined,
          sprint_status: deliveryTarget === "sl" ? "ready" : undefined,
          critique_rounds_completed: 1,
          rounds_completed: 1
        };
      }
    }
  });
  try {
    const emptyArch = provider();
    await assert.rejects(
      () => env.service.execute({ text: "tạo kế hoạch từ các ý tưởng", conversationId: "CONV-IDEAS", requestArchitecture: emptyArch.requestArchitecture }),
      (error) => error.code === "PLAN_IDEAS_EMPTY" && error.statusCode === 409
    );

    const appendMsg = (id, ts, role, type, correlationId, payload) => env.communications.append({
      id,
      project_id: "PROJECT-A",
      sender: { id: role === "project_owner" ? "project-owner" : "architecture-manager", role },
      recipient: { id: role === "project_owner" ? "architecture-manager" : "NODE", role: role === "project_owner" ? "architecture_manager" : "node" },
      message_type: type,
      conversation_id: "CONV-IDEAS",
      correlation_id: correlationId,
      payload,
      timestamp: ts
    });

    appendMsg("MSG-OWN-1", "2026-11-02T01:00:01.000Z", "project_owner", "owner.message", "CORR-1", { text: "Đề xuất cơ chế bộ nhớ đệm cho truy vấn" });
    appendMsg("MSG-IDEA-1", "2026-11-02T01:00:02.000Z", "architecture_manager", "architecture.message.received", "CORR-1", { text: "## Ý tưởng 1: Bộ nhớ đệm Redis\nLưu kết quả truy vấn theo TTL.", content_type: "text/markdown", is_idea: true });
    appendMsg("MSG-FOLLOW-1A", "2026-11-02T01:00:03.000Z", "project_owner", "owner.message", "CORR-1F", { text: "Bổ sung cơ chế xóa cache khi dữ liệu thay đổi." });
    appendMsg("MSG-FOLLOW-1B", "2026-11-02T01:00:04.000Z", "architecture_manager", "architecture.message.received", "CORR-1F", { text: "Đã ghi nhận invalidation theo sự kiện ghi.", content_type: "text/markdown", is_idea: false });
    appendMsg("MSG-OWN-2", "2026-11-02T01:00:05.000Z", "project_owner", "owner.message", "CORR-2", { text: "Đề xuất cơ chế giới hạn tốc độ API" });
    appendMsg("MSG-IDEA-2", "2026-11-02T01:00:06.000Z", "architecture_manager", "architecture.message.received", "CORR-2", { text: "## Ý tưởng 2: Rate Limiting\nÁp dụng token bucket cho mỗi project.", content_type: "text/markdown", is_idea: true });
    appendMsg("MSG-FOLLOW-2A", "2026-11-02T01:00:07.000Z", "project_owner", "owner.message", "CORR-2F", { text: "Ngưỡng mặc định là 120 req/phút.\ntạo kế hoạch từ các ý tưởng, giao việc cho SE" });

    const arch = provider();
    const created = await env.service.execute({
      text: "tạo kế hoạch từ các ý tưởng, giao việc cho SE",
      conversationId: "CONV-IDEAS",
      requestArchitecture: arch.requestArchitecture
    });

    assert.equal(created.source_kind, "marked_ideas");
    assert.equal(created.delivery_target, "se");
    assert.equal(created.idea_count, 2);
    assert.equal(Array.isArray(created.plans), true);
    assert.equal(created.plans.length, 2);
    assert.notEqual(created.plans[0].plan_id, created.plans[1].plan_id);
    assert.notEqual(created.plans[0].source_summary_path, created.plans[1].source_summary_path);
    assert.equal(created.plans[0].idea_message_id, "MSG-IDEA-1");
    assert.equal(created.plans[1].idea_message_id, "MSG-IDEA-2");

    const intake1 = JSON.parse(await env.fileService.readFile({ path: `.forge/runtime/nf/plans/${created.plans[0].plan_id}/conversation-intake.json` }));
    const intake2 = JSON.parse(await env.fileService.readFile({ path: `.forge/runtime/nf/plans/${created.plans[1].plan_id}/conversation-intake.json` }));
    assert.match(intake1.text, /Bộ nhớ đệm Redis/);
    assert.match(intake1.text, /Bổ sung cơ chế xóa cache khi dữ liệu thay đổi/);
    assert.doesNotMatch(intake1.text, /Rate Limiting/);
    assert.match(intake2.text, /Rate Limiting/);
    assert.match(intake2.text, /Ngưỡng mặc định là 120 req\/phút/);
    assert.doesNotMatch(intake2.text, /tạo kế hoạch từ các ý tưởng, giao việc cho SE/);

    assert.equal(handoffCalls.length, 2);
    assert.deepEqual(handoffCalls.map((c) => c.idea_message_id), ["MSG-IDEA-1", "MSG-IDEA-2"]);
    assert.deepEqual(handoffCalls.map((c) => c.delivery_target), ["se", "se"]);
  } finally {
    await env.close();
  }
});

test("a standalone create trigger generates r1 with Node's sha256 and a per-revision canonical source snapshot", async () => {
  const f = await fixture();
  try {
    const p = provider();
    const result = await f.service.execute({ text: "Create the architecture plan", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: p.requestArchitecture });
    assert.equal(p.prompts.length, 2, "Node discovers owner decisions first, then requests plan JSON only");
    assert.match(p.prompts[1], /return ONLY one JSON object/);
    assert.ok(!p.prompts[1].includes("Return only Markdown"), "AM is never asked for Markdown bytes");
    assert.equal(result.command, "/plan");
    assert.equal(result.status, "awaiting_human_approval");
    assert.equal(result.run_started, false);
    assert.equal(result.revision, 1);
    assert.match(result.plan_id, /^PLAN-PROJECT-A-/);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
    assert.match(result.source_summary_sha256, /^[a-f0-9]{64}$/);
    assert.match(result.source_summary_path, /\/plans\/PLAN-PROJECT-A-[^/]+\/plan-source-r1\.json$/);
    assert.match(result.conversation_id, /CONV-A/);
    assert.ok(result.markdown.startsWith("# Plan: Conversation plan"), "one Plan heading rendered in this conversation");
    assert.ok(result.markdown.includes("## 5. Outcomes"));
    assert.ok(result.markdown.includes("## 7. Evidence and assumptions"));
    assert.ok(result.markdown.includes("```nodeforge-owner-decisions"), "Node alone appends the authoritative decision record");
    const anchor = JSON.parse(await f.fileService.readFile({ path: result.source_summary_path }));
    assert.deepEqual(anchor, JSON.parse(PLAN_JSON), "the retained anchor holds the canonical plan JSON base");
    const stored = await f.service.execute({ text: "Create the architecture plan", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: p.requestArchitecture });
    assert.notEqual(stored.plan_id, result.plan_id, "each conversation create request produces its own locked revision");
  } finally { await f.close(); }
});

// Covers the real JSON-to-persisted-plan boundary that rejected valid lifecycle
// requirements before the revision existed, preserving source bytes for handoff.
test("conversation planning persists symbolic project IDs and route parameters unchanged", async () => {
  const f = await fixture();
  try {
    const plan = JSON.parse(PLAN_JSON);
    plan.outcomes[0].acceptance_criteria = ["Support PROJECT-<uuid> and PROJECT-NODEFORGE", "GET /forge/v1/projects/<projectId> returns the project"];
    const result = await f.service.execute({ text: "Create the architecture plan", conversationId: "CONV-PROJECT", requestArchitecture: provider(JSON.stringify(plan)).requestArchitecture });
    assert.equal(result.status, "awaiting_human_approval");
    assert.equal(result.revision, 1);
    assert.equal(result.run_started, false);
    assert.deepEqual(readMarkdownSprintScope(result.markdown)[0].acceptance_criteria, plan.outcomes[0].acceptance_criteria);
    assert.deepEqual(JSON.parse(await f.fileService.readFile({ path: result.source_summary_path })), plan);
  } finally { await f.close(); }
});

test("questions, quoted text, fenced examples and ordinary prose containing the trigger stay normal conversation", async () => {
  const f = await fixture();
  try {
    for (const text of ["Should we create the architecture plan?", "> create the architecture plan", "```\ncreate the architecture plan\n```", "We discussed how one might create the architecture plan over many turns."]) {
      assert.equal(detectPlanCreateTrigger(text), null);
      assert.equal(isConversationPlanMessage(text), false);
      assert.equal(f.service.isCommand(text), false);
      const p = provider();
      assert.equal(await f.service.execute({ text, conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: p.requestArchitecture }).then(() => "ran", (error) => error.code), "COMMAND_INVALID");
      assert.equal(p.prompts.length, 0, "no Architecture invocation for ordinary conversation");
    }
    assert.equal(detectPlanCreateTrigger("Create the architecture plan"), "Create the architecture plan");
    assert.equal(detectPlanUpdateTrigger("Update the plan"), "Update the plan");
    assert.equal(detectPlanApproveTrigger("Approve the plan"), "Approve the plan");
    assert.deepEqual(["normal_chat", "ticket_create"], ["normal_chat", "ticket_create"], "the transport intent whitelist keeps exactly these two values");
  } finally { await f.close(); }
});

test("a message mixing create or update with approve never approves and creates no revision", async () => {
  const f = await fixture();
  try {
    assert.throws(() => assertNoMixedPlanningApproval("Create the architecture plan\nApprove the plan"), { code: "PLAN_APPROVAL_MIXED" });
    assert.throws(() => assertNoMixedPlanningApproval("Update the plan\n/approve PLAN-PROJECT-A-1"), { code: "PLAN_APPROVAL_MIXED" });
    assertNoMixedPlanningApproval("/approve PLAN-PROJECT-A-1");
    const p = provider();
    await assert.rejects(f.service.execute({ text: "Create the architecture plan\n/approve PLAN-PROJECT-A-1", conversationId: "CONV-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER", requestArchitecture: p.requestArchitecture }), { code: "PLAN_APPROVAL_MIXED" });
    assert.equal(p.prompts.length, 0, "a mixed message never invokes Architecture and never creates a revision");
    await assert.rejects(f.service.execute({ text: "Update the plan\nApprove the plan", conversationId: "CONV-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER", requestArchitecture: p.requestArchitecture }), { code: "PLAN_APPROVAL_MIXED" });
  } finally { await f.close(); }
});

test("an approve phrase alone is never an approval and needs the exact slash command", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.execute({ text: "Approve the plan", conversationId: "CONV-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER" }), { code: "COMMAND_INVALID" });
    const created = await f.service.execute({ text: "Create the architecture plan", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture: provider().requestArchitecture });
    await assert.rejects(f.service.execute({ text: `/approve ${created.plan_id}`, conversationId: "CONV-A", project_id: "PROJECT-A", approvedOwnerId: "OWNER", approvalRevision: created.revision, approvalSha256: created.sha256 }), { code: "PLAN_APPROVAL_REQUIRED" });
    assert.equal(created.run_started, false);
  } finally { await f.close(); }
});

test("parseConversationPlanCreateTrigger parses all combinations of (conversation | markdown_file) x (none | sl | se) in Vietnamese and English", () => {
  const cases = [
    ["tạo kế hoạch từ cuộc trao đổi", { source_kind: "conversation", source_path: null, delivery_target: "none" }],
    ["tạo kế hoạch từ cuộc trao đổi và giao việc cho SL", { source_kind: "conversation", source_path: null, delivery_target: "sl" }],
    ["tạo kế hoạch kiến trúc, giao việc cho SE", { source_kind: "conversation", source_path: null, delivery_target: "se" }],
    ["Create an architecture plan and hand off to Sprint Leader", { source_kind: "conversation", source_path: null, delivery_target: "sl" }],
    ["Generate a plan from this conversation, delegate to System Engineer", { source_kind: "conversation", source_path: null, delivery_target: "se" }],
    ["tạo kế hoạch từ docs/spec.md", { source_kind: "markdown_file", source_path: "docs/spec.md", delivery_target: "none" }],
    ["tạo kế hoạch từ file `docs/spec.md`, giao việc cho SL", { source_kind: "markdown_file", source_path: "docs/spec.md", delivery_target: "sl" }],
    ["tạo kế hoạch kiến trúc từ docs/architecture/plan.md và giao việc cho SE", { source_kind: "markdown_file", source_path: "docs/architecture/plan.md", delivery_target: "se" }],
    ["Create the architecture plan from docs/spec.md and hand off to SL", { source_kind: "markdown_file", source_path: "docs/spec.md", delivery_target: "sl" }],
    ['Draft a plan from file "docs/spec.md", assign to SE.', { source_kind: "markdown_file", source_path: "docs/spec.md", delivery_target: "se" }]
  ];
  for (const [input, expected] of cases) {
    const parsed = parseConversationPlanCreateTrigger(input);
    assert.ok(parsed, `Expected trigger match for: ${input}`);
    assert.equal(parsed.source_kind, expected.source_kind, input);
    assert.equal(parsed.source_path, expected.source_path, input);
    assert.equal(parsed.delivery_target, expected.delivery_target, input);
    assertNoMixedPlanningApproval(input);
  }
  for (const ignored of [
    "tạo kế hoạch từ docs/spec.md, giao việc cho SE?",
    "> tạo kế hoạch từ docs/spec.md, giao việc cho SE",
    "```\ntạo kế hoạch từ docs/spec.md, giao việc cho SE\n```"
  ]) {
    assert.equal(parseConversationPlanCreateTrigger(ignored), null, ignored);
  }
});

test("self-healing planning loop repairs clarification, JSON schema, and missing evidence errors within retry limit and halts safely when exhausted", async () => {
  const f = await fixture();
  try {
    const receiptState = {
      active_file_checksums: { "backend/src/application/owner-chat-command-service.js": { sha256: "sha256:" + "a".repeat(64), total_lines: 185, status: "read" } },
      discovery_receipts: [{ tool: "read_file", path: "backend/src/application/owner-chat-command-service.js", sha256: "sha256:" + "a".repeat(64), total_lines: 185 }]
    };
    const serviceWithState = createOwnerChatCommandService({
      projectId: "PROJECT-A",
      fileService: f.fileService,
      planStore: createHumanPlanStore({ projectId: "PROJECT-A", database: f.database, fileService: f.fileService }),
      markdownPlanStore: createMarkdownPlanStore({ projectId: "PROJECT-A", database: f.database, fileService: f.fileService }),
      conversationStateStore: { get: async () => receiptState },
      maxSelfHealAttempts: 2
    });

    const missingEvidencePlan = JSON.stringify({
      ...JSON.parse(PLAN_JSON),
      evidence: [{ path: "docs/non-existent-file.md", location: "L1-L10", fact: "Missing file reference." }]
    });
    const prompts = [];
    let clarifyCalls = 0;
    let genCalls = 0;
    const created = await serviceWithState.execute({
      text: "Create the architecture plan",
      conversationId: "CONV-SELF-HEAL",
      requestArchitecture: async (prompt) => {
        prompts.push(prompt);
        if (prompt.startsWith("Architecture clarification discovery")) {
          clarifyCalls += 1;
          return clarifyCalls === 1 ? "not valid json {" : '{"questions":[]}';
        }
        genCalls += 1;
        if (genCalls === 1) return '{"malformed_plan":';
        if (genCalls === 2) return missingEvidencePlan;
        return PLAN_JSON;
      }
    });

    assert.equal(created.revision_created, true);
    assert.equal(created.revision, 1);
    assert.equal(clarifyCalls, 2, "Clarification self-healed on retry 1");
    assert.equal(genCalls, 3, "Plan generation self-healed after malformed JSON (retry 1) and DISCOVERY_INCOMPLETE missing evidence (retry 2)");
    assert.match(prompts[1], /SELF-HEALING CLARIFICATION RETRY 1\/2/);
    assert.match(prompts[1], /backend\/src\/application\/owner-chat-command-service\.js/, "Discovery Compact Receipt preserved during clarification retry");
    assert.match(prompts[3], /SELF-HEALING PLAN GENERATION RETRY 1\/2 — ERROR ARCHITECTURE_PLAN_JSON_INVALID/);
    assert.match(prompts[4], /SELF-HEALING PLAN GENERATION RETRY 2\/2 — ERROR DISCOVERY_INCOMPLETE/);
    assert.match(prompts[4], /docs\/non-existent-file\.md/, "Missing evidence path diagnostic included in repair prompt");
    assert.match(prompts[4], /backend\/src\/application\/owner-chat-command-service\.js/, "Discovery Compact Receipt preserved across generation retries");

    // Exhausted retries halt safely without persisting an invalid revision
    const failPrompts = [];
    await assert.rejects(
      () => serviceWithState.execute({
        text: "Create the architecture plan",
        conversationId: "CONV-EXHAUSTED",
        requestArchitecture: async (prompt) => {
          failPrompts.push(prompt);
          if (prompt.startsWith("Architecture clarification discovery")) return '{"questions":[]}';
          return missingEvidencePlan;
        }
      }),
      (error) => error.code === "DISCOVERY_INCOMPLETE" && /docs\/non-existent-file\.md/.test(error.message)
    );
    assert.equal(failPrompts.length, 4, "1 clarification + 1 initial generation + 2 self-heal retries before halting");
  } finally {
    await f.close();
  }
});

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
import { assertNoMixedPlanningApproval, detectPlanApproveTrigger, detectPlanCreateTrigger, detectPlanUpdateTrigger, isConversationPlanMessage } from "../../src/modules/governance/conversation-plan-trigger.js";

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
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-plan-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/owner-chat-command-service.js", content: "// evidence target for the plan gate\n", replace: true });
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: createHumanPlanStore({ projectId: "PROJECT-A", database, fileService }), markdownPlanStore: createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService }) });
  return { database, fileService, root, service, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Scripts one Architecture provider that answers clarification and plan requests separately.
function provider(planAnswer = PLAN_JSON) {
  const prompts = [];
  const requestArchitecture = async (prompt) => { prompts.push(prompt); return prompt.startsWith("Architecture clarification discovery") ? '{"questions":[]}' : planAnswer; };
  return { prompts, requestArchitecture };
}

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

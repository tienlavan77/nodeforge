// Boundary security tests for conversation plan approval (AC-7, AC-8, AC-10, AC-17).
// Business purpose: proves that a message mixing create/update intent with approve intent performs
// only the create/update path and requests a LATER separate approval, so it never records a plan
// decision for that message; quoted, fenced and interrogative approval text has no approval side
// effect at all; a missing rendered revision snapshot cannot be approved; approval keeps the existing
// Architecture Manager runtime restrictions, never grants extra authority and never starts a RUN.
// Technical description: drives the real approval service over the real conversation planning service,
// Markdown plan store and File Service, then asserts persisted markdown_plan_decisions state and the
// fail-closed governance codes, so the boundaries are executable behavior rather than text checks.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createConversationPlanApprovalService } from "../../src/application/conversation-plan-approval-service.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const PLAN_JSON = JSON.stringify({
  title: "Boundary plan", objective: "Approval stays separated from create and update.",
  background: "The owner creates a plan before any approval routing is attempted.",
  scope: ["Approval boundary tests"], outcomes: [{ id: "O1", outcome: "Mixed messages never approve", acceptance_criteria: ["no decision row for mixed text"], guardrails: ["No RUN", "No extra permission"] }],
  evidence: [{ path: "backend/src/application/conversation-plan-approval-service.js", location: "L1", fact: "Approval routing is fail-closed." }],
  assumptions: ["Owner reviews the rendered plan."], constraints: ["Preserve runtime restrictions"], risks: ["Blind approval"], verification: "Focused unit tests."
});
const NO_QUESTIONS = '{"questions":[]}';

// Applies the unchanged owner-facing Markdown gates to the real renderer bytes.
async function validateMarkdown(markdown) {
  if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw Object.assign(new Error("bad frame"), { code: "ARCHITECTURE_PLAN_INVALID" });
  if (!/discovery complete/i.test(markdown) || !/assumption|unverified|unknown|uncertain/i.test(markdown)) throw Object.assign(new Error("incomplete discovery"), { code: "DISCOVERY_INCOMPLETE" });
  readMarkdownSprintScope(markdown);
}

// Creates real storage plus a conversation planner and a handoff-counting approval service.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-approval-boundary-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const answers = [NO_QUESTIONS, PLAN_JSON];
  let index = 0;
  const requestArchitecture = async (prompt) => { index++; return prompt.startsWith("Architecture clarification discovery") ? NO_QUESTIONS : PLAN_JSON; };
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions: createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService }), requestArchitecture });
  const calls = { handoffs: 0, am: 0, announced: 0, stateAtAnnounce: null };
  const decisions = () => database.all("SELECT * FROM markdown_plan_decisions");
  const service = createConversationPlanApprovalService({ projectId: "PROJECT-A", markdownPlanStore, sprintRegistry: { get: () => ({ status: "planned" }), setStatus: async ({ status }) => ({ status }) }, handoffApprovedPlan: async () => { calls.handoffs++; return { status: "handed_to_sprint_leader", sprint_id: "SPRINT-B" }; }, announceApprovalIdentity: async (info) => { calls.announced++; calls.stateAtAnnounce = { decisions: decisions().length, handoffs: calls.handoffs, info }; } });
  const close = async () => { await database.close(); await rm(root, { recursive: true, force: true }); };
  return { database, fileService, markdownPlanStore, planning, service, calls, decisions, close, answers, nextAnswer: () => answers[Math.min(index++, answers.length - 1)] };
}

// Proves a create/update message carrying approve intent records no decision and defers approval.
test("a mixed create/update-plus-approve message records no decision and requires a separate approval", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    assert.equal(created.revision, 1, "the accepted create path still runs before any approval attempt");
    assert.equal(f.decisions().length, 0);
    for (const mixed of ["Create the architecture plan\nApprove the plan", "Update the plan\nApprove the plan", "/plan backend/x.md\n/approve PLAN-PROJECT-A-1"]) {
      const rejection = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", text: mixed }).then(() => null, (error) => error);
      assert.equal(rejection?.code, "PLAN_APPROVAL_MIXED", `must reject mixed: ${mixed.split("\n")[0]}`);
      assert.match(rejection.message, /then send \/approve or a standalone approve line as a separate message/, "the guard asks for a later separate approval");
    }
    assert.equal(f.decisions().length, 0, "no markdown_plan_decisions row is ever written for a mixed message");
    assert.equal(f.calls.handoffs, 0, "a mixed message never reaches handoff");
    const rendered = await f.service.selectPendingRevision({ conversationId: "CONV-A" });
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", text: "Approve the plan" }), { code: "PLAN_APPROVAL_CAPTURE_REQUIRED" }, "the separate approval must carry the captured rendered identity; an unpinned delivery is rejected before any side effect");
    assert.equal(f.decisions().length, 0, "an unpinned standalone approval still records no decision");
    const approved = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", text: "Approve the plan", approvalRevision: rendered.revision, approvalSha256: rendered.sha256 });
    assert.equal(approved.status, "handed_to_sprint_leader");
    assert.equal(approved.run_started, false);
    assert.equal(f.decisions().length, 1, "only the standalone later approval records a decision");
    assert.equal(f.calls.announced, 1, "the standalone approval announces exactly once");
    assert.equal(f.calls.stateAtAnnounce.decisions, 0, "the announcement lands before any decision row exists");
    assert.equal(f.calls.stateAtAnnounce.handoffs, 0, "the announcement lands before any handoff happens");
  } finally { await f.close(); }
});

// Proves quoted, fenced and interrogative approval text has zero approval side effects.
test("quoted, fenced and interrogative approval text produces no approval side effect", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    for (const inert of ["Should we approve the plan?", "> approve the plan", "```\napprove the plan\n```", "The owner might approve the plan after reviewing it."]) {
      await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", text: inert }), { code: "PLAN_APPROVAL_TRIGGER_REQUIRED" }, `must be inert: ${inert.slice(0, 24)}`);
    }
    assert.equal(f.decisions().length, 0, "inert approval text records no decision");
    assert.equal(f.calls.handoffs, 0, "inert approval text never hands off");
  } finally { await f.close(); }
});

// Proves an approval carrying no captured rendered identity is rejected before any side effect.
test("an approval without the captured revision/SHA-256 fails with PLAN_APPROVAL_CAPTURE_REQUIRED and zero side effects", async () => {
  const f = await fixture();
  try {
    await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    for (const unpinned of [
      { conversationId: "CONV-A", approvedOwnerId: "OWNER" },
      { conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: 1 },
      { conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalSha256: "f".repeat(64) },
    ]) {
      await assert.rejects(() => f.service.approveFromConversation(unpinned), { code: "PLAN_APPROVAL_CAPTURE_REQUIRED" }, "approval without a fully captured rendered identity must fail closed before decide/handoff");
    }
    assert.equal(f.decisions().length, 0, "an unpinned approval never writes markdown_plan_decisions");
    assert.equal(f.calls.handoffs, 0, "an unpinned approval never reaches handoff");
    assert.equal(f.calls.announced, 0, "an unpinned approval never announces an unverified head");
  } finally { await f.close(); }
});

// Proves an update arriving between render capture and approval cannot authorize the new revision.
test("an intervening update makes the captured r1 identity stale and only the r2 capture can approve", async () => {
  const f = await fixture();
  try {
    const first = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const second = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(second.revision, 2);
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: first.revision, approvalSha256: first.sha256 }), { code: "PLAN_APPROVAL_STALE" }, "the owner's captured r1 identity is superseded by r2 and cannot authorize it");
    assert.equal(f.decisions().length, 0, "the redirect attempt records no decision");
    assert.equal(f.calls.handoffs, 0, "the redirect attempt never reaches handoff");
    assert.equal(f.calls.announced, 0, "a stale capture never announces a side effect");
    const approved = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: second.revision, approvalSha256: second.sha256 });
    assert.equal(approved.status, "handed_to_sprint_leader", "only a capture matching the newest render approves");
    assert.equal(f.calls.stateAtAnnounce.decisions, 0, "even the valid approval announces the r2 identity before writing the decision");
    assert.equal(f.calls.stateAtAnnounce.handoffs, 0);
  } finally { await f.close(); }
});

// Proves a revision whose source snapshot is missing cannot be approved into handoff.
test("a missing rendered source snapshot fails closed with no decision and no handoff", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    await f.fileService.atomicWrite({ path: created.source_summary_path, content: "", replace: true });
    await f.database.run("DELETE FROM markdown_plan_revisions WHERE plan_id=?", [created.plan_id]);
    await assert.rejects(() => f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER" }), { code: "PLAN_APPROVAL_PENDING_MISSING" });
    assert.equal(f.decisions().length, 0, "an unresolvable revision cannot authorize a decision");
    assert.equal(f.calls.handoffs, 0);
  } finally { await f.close(); }
});

// Proves approval never grants execution or dispatch authority on a successful handoff.
test("approval keeps the AM runtime restriction and never dispatches a coder or supervisor", async () => {
  const f = await fixture();
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const result = await f.service.approveFromConversation({ conversationId: "CONV-A", approvedOwnerId: "OWNER", approvalRevision: 1, approvalSha256: created.sha256 });
    assert.equal(result.run_started, false);
    assert.equal(result.coder_dispatched, false);
    assert.equal(result.supervisor_dispatched, false);
    assert.equal(result.status, "handed_to_sprint_leader");
    assert.equal(f.calls.handoffs, 1, "approval only performs the Sprint Leader handoff, nothing more");
  } finally { await f.close(); }
});

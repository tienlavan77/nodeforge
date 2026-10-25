// Conversation planning source anchor and owner clarification durability contract.
// Business purpose: proves that an outstanding owner-level clarification pauses plan
// creation with no revision written (AC-8), that an authenticated /plan-continue style
// continuation keeps the confirmed policies and that only Node appends the authoritative
// owner-decision record (AC-2, AC-9), and that the Node-owned canonical JSON anchor keeps
// the existing SUMMARY snapshot gate: a missing or altered snapshot blocks approval and
// handoff through the unchanged integrity gates (AC-10).
// Technical description: runs the real SQLite markdown plan store, the real File Service
// and the durable clarification session store behind the conversation planning service,
// then reopens the tampered revision through assertApproved to show the gate still fails
// closed. Assertions are executable state transitions, never source-text matches.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { retainConversationPlanSource } from "../../src/modules/governance/conversation-plan-source.js";
import { readArchitectureDecisions } from "../../src/modules/governance/architecture-owner-decisions.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const PLAN_JSON = JSON.stringify({
  title: "Clarified plan",
  objective: "Create a plan only after the owner settles the storage policy.",
  background: "Owner started planning from the conversation without a path or command.",
  scope: ["Backend planning and governance modules"],
  outcomes: [{ id: "O1", outcome: "Plan locked after clarification", acceptance_criteria: ["No revision before owner answers", "Owner policy applied consistently"], guardrails: ["No approval authority change"] }],
  evidence: [{ path: "backend/src/application/conversation-planning-service.js", location: "L1", fact: "Node alone locks revisions." }],
  assumptions: ["Owner reviews the rendered plan before approval."],
  constraints: ["Preserve Markdown storage and handoff contracts"],
  risks: ["Snapshot could be edited after locking"],
  verification: "Focused unit tests plus Node verification."
});

const QUESTIONS_JSON = JSON.stringify({ questions: [{ id: "STORAGE", title: "Persistence", reason: "Only the owner can set data policy", options: [{ id: "LOCAL", label: "Local", description: "Device-local persistence" }, { id: "SERVER", label: "Server", description: "Server persistence with access control" }], recommended_option_id: "LOCAL" }] });

// Applies the unchanged owner-facing Markdown gates to one candidate plan document.
async function validateMarkdown(markdown) {
  if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw Object.assign(new Error("bad frame"), { code: "ARCHITECTURE_PLAN_INVALID" });
  if (!/discovery complete/i.test(markdown) || !/assumption|unverified|unknown|uncertain/i.test(markdown)) throw Object.assign(new Error("incomplete discovery"), { code: "DISCOVERY_INCOMPLETE" });
  readMarkdownSprintScope(markdown);
}

// Creates one conversation planner over real storage plus its Architecture call recorder.
async function fixture(answers) {
  const root = await mkdtemp(join(tmpdir(), "conversation-source-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const prompts = [];
  let index = 0;
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions: createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService }), requestArchitecture: async (prompt) => { prompts.push(prompt); return answers[Math.min(index++, answers.length - 1)]; } });
  return { database, fileService, markdownPlanStore, planning, prompts, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("outstanding owner clarification pauses creation and writes no revision", async () => {
  const f = await fixture([QUESTIONS_JSON, PLAN_JSON]);
  try {
    const result = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    assert.equal(result.status, "awaiting_owner_decisions");
    assert.equal(result.run_started, false);
    assert.equal(result.revision_created, false);
    assert.equal(result.revision, undefined);
    assert.deepEqual(f.markdownPlanStore.list(), [], "no plan revision exists while a decision is outstanding");
    assert.match(result.source_summary_path, /\/conversation-intake\.json$/);
    assert.match(result.source_summary_sha256, /^[a-f0-9]{64}$/);
    const session = await f.planning.continuePlan({ sessionId: result.session_id, conversationId: "CONV-A", ownerId: "", expectedVersion: 1, sourceSha256: result.source_summary_sha256 }).catch((error) => error.code);
    assert.equal(session, "PLAN_OWNER_UNAUTHORIZED", "continuation requires owner authentication");
  } finally { await f.close(); }
});

test("authenticated continuation preserves confirmed policies and only Node appends the decision record", async () => {
  const f = await fixture([QUESTIONS_JSON, PLAN_JSON]);
  try {
    const waiting = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const drafted = await f.planning.saveClarificationChoices({ sessionId: waiting.session_id, expectedVersion: 1, sourceSha256: waiting.source_summary_sha256, selections: { STORAGE: "SERVER" } });
    assert.equal(drafted.selections.STORAGE, "SERVER");
    const created = await f.planning.continuePlan({ sessionId: waiting.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: drafted.version, sourceSha256: waiting.source_summary_sha256 });
    assert.equal(created.status, "awaiting_human_approval");
    assert.equal(created.run_started, false);
    assert.equal(created.revision, 1);
    assert.equal(created.session_id, waiting.session_id);
    const record = readArchitectureDecisions(created.markdown);
    assert.equal(record.decisions[0].option_id, "SERVER", "the confirmed owner policy survives into the locked revision");
    assert.equal(record.owner_id, "OWNER");
    assert.match(record.source_sha256, /^[a-f0-9]{64}$/);
    assert.match(f.prompts.at(-1), /Confirmed owner decisions:[\s\S]*SERVER/, "Architecture receives the confirmed policy instead of re-asking");
    const stored = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: 1 });
    assert.equal(stored.status, "awaiting_human_approval");
    assert.equal(stored.source_path, created.source_summary_path);
    assert.equal(stored.sha256, created.sha256);
    assert.deepEqual(JSON.parse(await f.fileService.readFile({ path: stored.source_path })), JSON.parse(PLAN_JSON));
  } finally { await f.close(); }
});

test("missing or altered canonical snapshots block approval and handoff through the existing gates", async () => {
  const f = await fixture([QUESTIONS_JSON, PLAN_JSON]);
  try {
    const waiting = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const drafted = await f.planning.saveClarificationChoices({ sessionId: waiting.session_id, expectedVersion: 1, sourceSha256: waiting.source_summary_sha256, selections: { STORAGE: "LOCAL" } });
    const created = await f.planning.continuePlan({ sessionId: waiting.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: drafted.version, sourceSha256: waiting.source_summary_sha256 });
    const input = { planId: created.plan_id, revision: 1, sha256: created.sha256 };
    await f.markdownPlanStore.decide({ planId: created.plan_id, revision: 1, sha256: created.sha256, decision: "approved", approverId: "OWNER" });
    assert.equal((await f.markdownPlanStore.assertApproved(input)).status, "approved", "an intact anchor keeps the existing handoff gate working");
    const snapshot = `${created.path.replace(/\/ke-hoach-r1\.md$/, "")}/summary-r1.md`;
    assert.equal(await f.fileService.readFile({ path: snapshot }), await f.fileService.readFile({ path: created.source_summary_path }), "the existing gate snapshots the canonical anchor bytes");
    await f.fileService.atomicWrite({ path: snapshot, content: "tampered snapshot", replace: true });
    await assert.rejects(() => f.markdownPlanStore.assertApproved(input), { code: "PLAN_SOURCE_MISMATCH" });
    await f.fileService.deleteFile({ path: snapshot });
    await f.fileService.atomicWrite({ path: created.source_summary_path, content: JSON.stringify({ ...JSON.parse(PLAN_JSON), objective: "silently rewritten" }), replace: true });
    await assert.rejects(() => f.markdownPlanStore.assertApproved(input), { code: "PLAN_SOURCE_MISMATCH" }, "a restored snapshot must still match the recorded checksum");
    await assert.rejects(() => f.markdownPlanStore.assertApproved({ ...input, sha256: "b".repeat(64) }), { code: "PLAN_APPROVAL_REQUIRED" }, "a stale checksum never authorizes handoff");
  } finally { await f.close(); }
});

test("the anchor keeps the summary identity and refuses a conflicting re-anchor for one revision", async () => {
  const f = await fixture(['{"questions":[]}', PLAN_JSON]);
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-B" });
    assert.match(created.source_summary_sha256, /^[a-f0-9]{64}$/);
    const bytes = await f.fileService.readFile({ path: created.source_summary_path });
    assert.equal(createHash("sha256").update(bytes).digest("hex"), created.source_summary_sha256, "Node's recorded checksum is the exact-byte anchor hash");
    const planId = created.plan_id.match(/(PLAN-PROJECT-A-[^/]+)/)[1];
    await assert.rejects(() => retainConversationPlanSource({ fileService: f.fileService, planId, revision: 1, canonicalBytes: JSON.stringify({ ...JSON.parse(PLAN_JSON), title: `Other ${randomUUID().slice(0, 8)}` }) }), { code: "PLAN_SOURCE_MISMATCH" });
    await f.fileService.atomicWrite({ path: created.source_summary_path, content: JSON.stringify({ ...JSON.parse(PLAN_JSON), objective: "silently rewritten" }), replace: true });
    await assert.rejects(() => f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-B" }), { code: "PLAN_SOURCE_MISMATCH" });
    assert.equal(f.markdownPlanStore.list().length, 1, "a tampered anchor creates no further revision");
  } finally { await f.close(); }
});

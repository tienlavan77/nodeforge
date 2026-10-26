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
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
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
  const sessions = createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService });
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions, requestArchitecture: async (prompt, conversationId, options) => { assert.equal(options?.responseContentType, "text/plain"); prompts.push(prompt); const answer = answers[Math.min(index++, answers.length - 1)]; return typeof answer === "function" ? answer(prompt) : answer; } });
  return { database, fileService, markdownPlanStore, planning, sessions, prompts, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Persists precise multi-window AM citations through the complete conversation planning flow.
test("automatic generation locks a plan with AM evidence spanning multiple source ranges", async () => {
  const candidate = JSON.parse(PLAN_JSON);
  candidate.evidence[0].location = "L98–106; L136–157; L160–238";
  const f = await fixture(['{"questions":[]}', JSON.stringify(candidate)]);
  try {
    const result = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    assert.equal(result.revision_created, true);
    assert.match(result.markdown, /#L98–106; L136–157; L160–238\]/);
    assert.equal((await f.sessions.list("CONV-A"))[0].status, "completed");
    assert.equal(f.markdownPlanStore.list().length, 1);
  } finally { await f.close(); }
});

// An in-flight automatic plan must never be presented as interrupted or start a second SDK invocation.
test("automatic conversation generation stays generating and concurrent confirmation replays one completed plan", async () => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const f = await fixture(['{"questions":[]}', async () => { entered.resolve(); return release.promise; }]);
  const creation = f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
  try {
    await entered.promise;
    const [session] = await f.sessions.list("CONV-A");
    assert.equal(session.status, "generating");
    assert.equal(session.questions.length, 0);
    assert.equal(session.error_code, null);
    assert.deepEqual(f.markdownPlanStore.list(), []);
    const repeated = f.planning.continuePlan({ sessionId: session.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: session.version, sourceSha256: session.source_sha256 });
    release.resolve(PLAN_JSON);
    const [result, replay] = await Promise.all([creation, repeated]);
    assert.equal(replay.plan_id, result.plan_id);
    assert.equal(f.prompts.length, 2, "one discovery and one generation, no overlapping provider turn");
    assert.equal(f.markdownPlanStore.list().length, 1);
    const [completed] = await f.sessions.list("CONV-A");
    assert.equal(completed.status, "completed");
    assert.equal(completed.result.sha256, result.sha256);
  } finally { release.resolve(PLAN_JSON); await creation; await f.close(); }
});

// Automatic generation failures must become real retryable sessions instead of remaining ready forever.
test("failed automatic generation can retry from its persisted source and closes without a second revision", async () => {
  const f = await fixture(['{"questions":[]}', () => { throw Object.assign(new Error("offline"), { code: "SERVICE_UNAVAILABLE" }); }, PLAN_JSON]);
  try {
    await assert.rejects(f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" }), { code: "SERVICE_UNAVAILABLE" });
    const [session] = await f.sessions.list("CONV-A");
    assert.equal(session.status, "generation_failed");
    assert.equal(session.error_code, "SERVICE_UNAVAILABLE");
    assert.equal(f.markdownPlanStore.list().length, 0);
    const input = { sessionId: session.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: session.version, sourceSha256: session.source_sha256 };
    const result = await f.planning.continuePlan(input);
    assert.deepEqual(await f.planning.continuePlan(input), result);
    assert.equal(f.prompts.length, 3);
    assert.equal(f.markdownPlanStore.list().length, 1);
    assert.equal((await f.sessions.list("CONV-A"))[0].status, "completed");
  } finally { await f.close(); }
});

// Real failures remain retryable, while successful recovery closes the session and preserves the approved choice identity.
test("conversation generation failure retains confirmed choices and retries without another discovery or token decision", async () => {
  const f = await fixture([QUESTIONS_JSON, () => { throw Object.assign(new Error("model offline"), { code: "SERVICE_UNAVAILABLE" }); }, PLAN_JSON]);
  try {
    const pending = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const saved = await f.planning.saveClarificationChoices({ sessionId: pending.session_id, expectedVersion: 1, sourceSha256: pending.source_summary_sha256, selections: { STORAGE: "SERVER" } });
    const input = { sessionId: saved.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: saved.version, sourceSha256: saved.source_sha256 };
    await assert.rejects(f.planning.continuePlan(input), { code: "SERVICE_UNAVAILABLE" });
    const [failed] = await createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService: f.fileService }).list("CONV-A");
    assert.equal(failed.status, "generation_failed");
    assert.equal(failed.error_code, "SERVICE_UNAVAILABLE");
    assert.equal(failed.confirmation_version, saved.version);
    assert.equal(failed.owner_id, "OWNER");
    const result = await f.planning.continuePlan(input);
    assert.equal(readArchitectureDecisions(result.markdown).decisions[0].option_id, "SERVER");
    assert.deepEqual(await f.planning.continuePlan(input), result);
    await assert.rejects(f.planning.continuePlan({ ...input, ownerId: "OTHER" }), { code: "ARCHITECTURE_SESSION_STALE" });
    assert.equal(f.prompts.length, 3);
    assert.equal((await f.sessions.list("CONV-A"))[0].status, "completed");
  } finally { await f.close(); }
});

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

// Builds the real owner command route over shared plan storage for continuation dispatch coverage.
// Business purpose: /plan-continue is routed by owner-chat-command-service, and conversation
// sessions share the clarification store with the legacy Markdown planner; this fixture exercises
// the actual route so a mis-dispatch to planning.resume (Markdown gate, session.plan_id, intake
// source) fails loudly instead of silently bypassing the JSON contract (AC-8, AC-2).
// Technical description: wires createOwnerChatCommandService to the real SQLite stores, the real
// File Service and a scripted Architecture provider, mirroring the creation fixture's answers.
async function commandFixture(answers) {
  const root = await mkdtemp(join(tmpdir(), "conversation-route-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const prompts = [];
  let index = 0;
  const requestArchitecture = async (prompt) => { prompts.push(prompt); return answers[Math.min(index++, answers.length - 1)]; };
  const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: createHumanPlanStore({ projectId: "PROJECT-A", database, fileService }), markdownPlanStore });
  const sessions = createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService });
  return { fileService, markdownPlanStore, service, sessions, prompts, requestArchitecture, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("the authenticated /plan-continue route resumes conversation sessions through the JSON planner, not the legacy Markdown planner", async () => {
  const f = await commandFixture([QUESTIONS_JSON, PLAN_JSON]);
  try {
    const waiting = await f.service.execute({ text: "Create the architecture plan", conversationId: "CONV-C", project_id: "PROJECT-A", requestArchitecture: f.requestArchitecture });
    assert.equal(waiting.status, "awaiting_owner_decisions");
    assert.equal(waiting.revision_created, false);
    assert.match(waiting.source_summary_path, /\/conversation-intake\.json$/);
    const drafted = await f.sessions.update(waiting.session_id, { expectedVersion: 1, sourceSha256: waiting.source_summary_sha256, selections: { STORAGE: "SERVER" }, notes: {} });
    const created = await f.service.execute({ text: `/plan-continue ${waiting.session_id}`, conversationId: "CONV-C", project_id: "PROJECT-A", approvedOwnerId: "OWNER", planningVersion: drafted.version, planningSourceSha256: waiting.source_summary_sha256, requestArchitecture: f.requestArchitecture });
    assert.equal(created.plan_id, waiting.plan_id, "the conversation plan identity from the intake anchor is preserved across continuation");
    assert.equal(created.revision, 1);
    assert.equal(created.status, "awaiting_human_approval");
    assert.equal(created.run_started, false);
    assert.match(created.source_summary_path, /\/plans\/PLAN-PROJECT-A-[^/]+\/plan-source-r1\.json$/, "the canonical JSON anchor is the retained source snapshot, not the intake file");
    assert.ok(!f.prompts.at(-1).includes("Return only Markdown"), "the conversation continuation never falls back to the legacy Markdown prompt");
    const record = readArchitectureDecisions(created.markdown);
    assert.equal(record.decisions[0].option_id, "SERVER", "confirmed owner choices survive through the route");
    assert.equal(record.owner_id, "OWNER", "only Node appends the authoritative owner-decision record");
    const stored = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: 1 });
    assert.deepEqual(JSON.parse(await f.fileService.readFile({ path: stored.source_path })), JSON.parse(PLAN_JSON));
  } finally { await f.close(); }
});

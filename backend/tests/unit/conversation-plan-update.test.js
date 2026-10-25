// Conversation-originated Architecture Plan update through the shared merge contract.
// Business purpose: proves O2/O5 for updates - an owner says "Update the plan" (or the
// additive `/plan-update` slash alias) in the same conversation, Node reads the current
// canonical revision, merges one valid AM RFC 7396 merge patch (nullable:false at root,
// whole-array replacement) with the exact same schema, merge engine, renderer and
// Node-owned source-anchor mechanism as creation, and locks r<n+1> (AC-1, AC-2, AC-8,
// AC-9, AC-12). Historical revisions stay readable with status `superseded` (AC-3), an
// invalid or ambiguous patch answer is rejected with no revision written and no guessing
// from owner prose (AC-4, AC-6, AC-10, AC-11), a concurrent update on the same base
// yields PLAN_REVISION_CONFLICT instead of a second revision (AC-7), updates never pick
// another conversation's base and quoted, fenced or interrogative triggers never mutate
// plans (AC-8, AC-14), while /plan <file.md>, /approve <plan_id> and /plan-continue
// behavior is preserved by the unchanged command and gate suites (AC-5, AC-13).
// Technical description: runs the real SQLite markdown plan store, the real File Service
// and the durable clarification store behind the conversation planning service and the
// real owner command route, so every assertion is executable behavior and persisted
// state, never source-text matching.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";
import { createArchitectureClarificationStore } from "../../src/application/architecture-clarification-store.js";
import { createConversationPlanningService } from "../../src/application/conversation-planning-service.js";
import { createOwnerChatCommandService } from "../../src/application/owner-chat-command-service.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";
import { detectPlanUpdateTrigger, isConversationPlanMessage } from "../../src/modules/governance/conversation-plan-trigger.js";

const PLAN_JSON = JSON.stringify({
  title: "Updatable plan",
  objective: "Deliver the plan before any revision is requested.",
  background: "Owner created this plan from the conversation without a path or command.",
  scope: ["Original scope item"],
  outcomes: [{ id: "O1", outcome: "Plan locked as r1", acceptance_criteria: ["r1 exists"], guardrails: ["No approval authority change"] }],
  evidence: [{ path: "backend/src/application/conversation-planning-service.js", location: "L1", fact: "Node alone locks revisions." }],
  assumptions: ["Owner reviews the rendered plan before approval."],
  constraints: ["Preserve Markdown storage and handoff contracts"],
  risks: ["Provider may answer prose instead of a patch"],
  verification: "Focused unit tests plus Node commit-bound verification."
});

const PATCH_JSON = JSON.stringify({
  objective: "Deliver the plan plus the merged owner revision.",
  scope: ["Replaced whole scope array"],
  outcomes: [{ id: "O1", outcome: "Plan locked as r2", acceptance_criteria: ["r2 exists"], guardrails: ["No approval authority change"] }]
});

const NO_QUESTIONS = '{"questions":[]}';

// Applies the unchanged owner-facing Markdown gates to one candidate plan document.
async function validateMarkdown(markdown) {
  if (!/^# Plan:\s*\S/.test(markdown) || !/^## 1\. /m.test(markdown) || !/^## 7\. /m.test(markdown)) throw Object.assign(new Error("bad frame"), { code: "ARCHITECTURE_PLAN_INVALID" });
  if (!/discovery complete/i.test(markdown) || !/assumption|unverified|unknown|uncertain/i.test(markdown)) throw Object.assign(new Error("incomplete discovery"), { code: "DISCOVERY_INCOMPLETE" });
  readMarkdownSprintScope(markdown);
}

// Creates one conversation planner over real storage plus its scripted Architecture answers.
async function fixture(answers) {
  const root = await mkdtemp(join(tmpdir(), "conversation-update-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
  await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
  const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
  const prompts = [];
  const state = { index: 0 };
  const requestArchitecture = async (prompt) => { prompts.push(prompt); return answers[Math.min(state.index++, answers.length - 1)]; };
  const planning = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions: createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService }), requestArchitecture });
  return { database, fileService, markdownPlanStore, planning, prompts, requestArchitecture, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("a valid AM merge patch on the current base locks r2 through the shared anchor mechanism and supersedes r1", async () => {
  const f = await fixture([NO_QUESTIONS, PLAN_JSON, PATCH_JSON]);
  try {
    const created = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    assert.equal(created.revision, 1);
    const updated = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(updated.plan_id, created.plan_id, "the update stays on the same plan identity in the same conversation");
    assert.equal(updated.revision, 2, "Node reads the current base then creates r<n+1>");
    assert.equal(updated.status, "awaiting_human_approval");
    assert.equal(updated.run_started, false);
    assert.match(updated.source_summary_path, /\/plans\/PLAN-PROJECT-A-[^/]+\/plan-source-r2\.json$/, "the update uses the same Node-owned source-anchor mechanism as creation");
    assert.match(f.prompts.at(-1), /^Architecture plan update/, "the update prompt keeps the merge-patch contract");
    assert.ok(f.prompts.at(-1).includes("Canonical plan"), "the AM receives the retained canonical base JSON");
    const anchor = JSON.parse(await f.fileService.readFile({ path: updated.source_summary_path }));
    assert.equal(anchor.objective, "Deliver the plan plus the merged owner revision.", "root field replaced by the patch value");
    assert.deepEqual(anchor.scope, ["Replaced whole scope array"], "arrays are replaced wholesale, never merged item by item");
    assert.equal(anchor.outcomes[0].outcome, "Plan locked as r2", "nested outcome list carries the whole-array replacement");
    assert.equal(anchor.title, "Updatable plan", "untouched fields survive the merge unchanged");
    assert.equal(anchor.background, JSON.parse(PLAN_JSON).background);
    assert.equal(anchor.evidence.length, 1);
    assert.ok(updated.markdown.startsWith("# Plan: Updatable plan") && updated.markdown.includes("Plan locked as r2"), "the same renderer emits the new Markdown bytes");
    const previous = await f.markdownPlanStore.getRevision({ planId: created.plan_id, revision: 1 });
    assert.equal(previous.status, "superseded", "the historical revision stays readable and marked superseded");
    assert.equal(previous.sha256, created.sha256, "historical bytes are never rewritten");
    assert.equal(JSON.parse(await f.fileService.readFile({ path: created.source_summary_path })).objective, JSON.parse(PLAN_JSON).objective, "the r1 anchor snapshot keeps its exact bytes");
  } finally { await f.close(); }
});

test("an invalid or ambiguous AM answer creates no revision and asks AM to emit a valid payload instead of guessing", async () => {
  for (const bad of ["", "   ", "I recommend updating the objective in prose.", "{", "[1,2]", JSON.stringify({ objective: null }), JSON.stringify({ objective: "x", extra: 7 })]) {
    const f = await fixture([NO_QUESTIONS, PLAN_JSON, bad]);
    try {
      await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
      const promptsBefore = f.prompts.length;
      await assert.rejects(() => f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" }), (error) => {
        assert.equal(error.code, "ARCHITECTURE_PLAN_PATCH_INVALID", `must reject ambiguous answer: ${String(bad).slice(0, 24)}`);
        assert.match(error.message, /Architecture must return a valid RFC 7396 JSON merge patch payload/, "Node answers by requiring the AM payload, never inferring one");
        return true;
      });
      assert.equal(f.prompts.length, promptsBefore + 1, "one update prompt, never a full regeneration guess");
      const heads = f.markdownPlanStore.list();
      assert.equal(heads.length, 1);
      assert.equal(heads[0].revision, 1, "a rejected patch never creates a revision");
      let anchored = true;
      const rejectedAnchor = heads[0].source_path.replace(/r1\.json$/, "r2.json");
      try { await f.fileService.readFile({ path: rejectedAnchor }); }
      catch (error) { console.info("r2 anchor absent as required", { code: error.code ?? error.name }); anchored = false; }
      assert.equal(anchored, false, "no partial source snapshot is persisted for a rejected revision");
    } finally { await f.close(); }
  }
});

test("concurrent updates against the same base cannot both create the next revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-update-concurrent-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
    await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
    const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const sessions = createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService });
    const bootstrap = createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions, requestArchitecture: async (prompt) => (prompt.startsWith("Architecture clarification discovery") ? NO_QUESTIONS : PLAN_JSON) });
    const created = await bootstrap.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const mk = () => createConversationPlanningService({ projectId: "PROJECT-A", fileService, markdownPlanStore, validateMarkdown, sessions, requestArchitecture: async () => PATCH_JSON });
    const a = mk();
    const b = mk();
    const settled = await Promise.allSettled([a.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" }), b.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" })]);
    const ok = settled.filter((entry) => entry.status === "fulfilled");
    const failed = settled.filter((entry) => entry.status === "rejected");
    assert.equal(ok.length, 1, "exactly one update locks the next revision");
    assert.equal(failed.length, 1);
    assert.equal(failed[0].reason.code, "PLAN_REVISION_CONFLICT", "the stale attempt reports a revision conflict");
    const head = markdownPlanStore.list()[0];
    assert.equal(head.revision, 2, "the next revision is locked exactly once");
    assert.equal(head.sha256, ok[0].value.sha256, "the accepted revision bytes are never overwritten");
    const anchorBytes = await fileService.readFile({ path: ok[0].value.source_summary_path });
    assert.equal(JSON.parse(anchorBytes).objective, JSON.parse(PATCH_JSON).objective, "the accepted source snapshot stays intact");
    const previous = await markdownPlanStore.getRevision({ planId: created.plan_id, revision: 1 });
    assert.equal(previous.status, "superseded");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

test("an update never selects another conversation's base and only the requesting conversation's plan gains a revision", async () => {
  const f = await fixture([NO_QUESTIONS, PLAN_JSON, PATCH_JSON]);
  try {
    const first = await f.planning.createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" });
    const promptsBefore = f.prompts.length;
    await assert.rejects(() => f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-B" }), { code: "PLAN_UPDATE_TARGET_MISSING" }, "a conversation without its own plan base never borrows another conversation's revision");
    assert.equal(f.prompts.length, promptsBefore, "the rejected cross-conversation attempt never invokes Architecture");
    const untouched = f.markdownPlanStore.list().find((entry) => entry.plan_id === first.plan_id);
    assert.equal(untouched.revision, 1, "the other conversation's plan is untouched");
    const updated = await f.planning.updateFromConversation({ text: "Update the plan", conversationId: "CONV-A" });
    assert.equal(updated.plan_id, first.plan_id, "the update applies to the same conversation's plan");
    assert.equal(updated.revision, 2);
  } finally { await f.close(); }
});

test("the additive slash alias routes updates while quoted, fenced and interrogative triggers never mutate plans", async () => {
  const root = await mkdtemp(join(tmpdir(), "conversation-update-route-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  try {
    const fileService = createFileService({ projectRoot: root, allowPlanStorage: true, watcherIgnore: [".forge/**", "node_modules/**"] });
    await fileService.atomicWrite({ path: "backend/src/application/conversation-planning-service.js", content: "// evidence target\n", replace: true });
    const markdownPlanStore = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService });
    const answers = [NO_QUESTIONS, PLAN_JSON, PATCH_JSON];
    let index = 0;
    const requestArchitecture = async () => answers[Math.min(index++, answers.length - 1)];
    const service = createOwnerChatCommandService({ projectId: "PROJECT-A", fileService, planStore: createHumanPlanStore({ projectId: "PROJECT-A", database, fileService }), markdownPlanStore });
    const created = await service.execute({ text: "Create the architecture plan", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture });
    assert.equal(created.revision, 1);
    assert.equal(detectPlanUpdateTrigger("/plan-update"), "/plan-update", "the additive alias is a recognized standalone update trigger");
    const alias = await service.execute({ text: "/plan-update", conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture });
    assert.equal(alias.revision, 2);
    assert.equal(alias.plan_id, created.plan_id);
    for (const text of ["Should we update the plan?", "> update the plan", "```\nupdate the plan\n```", "We discussed how one might update the plan over many turns.", "/plan-update the later draft"]) {
      assert.equal(detectPlanUpdateTrigger(text), null, `must not trigger: ${text.slice(0, 32)}`);
      assert.equal(isConversationPlanMessage(text), false);
      assert.equal(service.isCommand(text), false, "the command boundary stays unchanged for non-triggers");
      await assert.rejects(() => service.execute({ text, conversationId: "CONV-A", project_id: "PROJECT-A", requestArchitecture }), { code: "COMMAND_INVALID" });
    }
    assert.equal(markdownPlanStore.list().length, 1, "one head plan only");
    assert.equal(markdownPlanStore.list()[0].revision, 2, "only the standalone alias update added a revision");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});
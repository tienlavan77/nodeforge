// Exercises durable plan recovery so repeated owner requests reuse the original AM
// candidate instead of generating conflicting bytes for an immutable revision. Real
// SQLite and File Service writes cover validation failures and interrupted indexing;
// no test grants approval, launches a ticket or overwrites conflicting retained files.
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
import { canonicalizeArchitecturePlanJSON } from "../../src/modules/governance/architecture-plan-json.js";
import { conversationPlanSourcePath } from "../../src/modules/governance/conversation-plan-source.js";
import { readMarkdownSprintScope } from "../../src/modules/governance/markdown-sprint-scope.js";

const PLAN = {
  title: "Ideas notebook", objective: "Keep project ideas outside ticket execution.",
  background: "Owner requested a persistent project notebook.", scope: ["Ideas panel and API"],
  outcomes: [{ id: "O1", outcome: "Persist Ideas", acceptance_criteria: ["status=open|done|all"], guardrails: ["No automatic RUN"] }],
  evidence: [{ path: "backend/src/ideas.js", fact: "Project API is composed here." }],
  assumptions: ["Owner reviews the plan."], constraints: ["Preserve project isolation"],
  risks: [], verification: "Focused notebook tests."
};

// Builds real plan storage with explicit fault points for pre-anchor validation and
// the database insertion after immutable files have already reached disk.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "conversation-plan-recovery-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const files = createFileService({ projectRoot: root, allowPlanStorage: true });
  const state = { calls: 0, rejectMarkdown: false, rejectInsert: false };
  const faultDatabase = { ...database, run(sql, params) {
    if (state.rejectInsert && sql.startsWith("INSERT INTO markdown_plan_revisions")) throw Object.assign(new Error("index unavailable"), { code: "INDEX_UNAVAILABLE" });
    return database.run(sql, params);
  } };
  const store = createMarkdownPlanStore({ projectId: "PROJECT-A", database: faultDatabase, fileService: files });
  const sessions = createArchitectureClarificationStore({ projectId: "PROJECT-A", fileService: files });
  // Creates a fresh service over the same persisted stores to model an API restart.
  function planner() {
    return createConversationPlanningService({ projectId: "PROJECT-A", fileService: files, markdownPlanStore: store, sessions,
      validateMarkdown: async (markdown) => {
        readMarkdownSprintScope(markdown);
        if (state.rejectMarkdown) throw Object.assign(new Error("invalid scope"), { code: "SPRINT_MARKDOWN_SCOPE" });
      },
      requestArchitecture: async (prompt) => {
        state.calls += 1;
        return prompt.startsWith("Architecture clarification") ? '{"questions":[]}' : JSON.stringify({ ...PLAN, title: `${PLAN.title} ${state.calls}` });
      } });
  }
  // Continues the same source-bound session without manufacturing another plan identity.
  async function resume() {
    const [session] = await sessions.list("CONV-A");
    return planner().continuePlan({ sessionId: session.session_id, conversationId: "CONV-A", ownerId: "OWNER", expectedVersion: session.version, sourceSha256: session.source_sha256 });
  }
  return { root, files, store, sessions, state, planner, resume, close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

// Invalid Markdown must not reserve r1 and make the owner's next attempt collide.
test("validation rejects before retaining an anchor and a corrected retry creates r1", async () => {
  const f = await fixture();
  try {
    f.state.rejectMarkdown = true;
    await assert.rejects(f.planner().createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" }), { code: "SPRINT_MARKDOWN_SCOPE" });
    const [session] = await f.sessions.list("CONV-A");
    const planId = session.source_path.split("/").at(-2);
    await assert.rejects(f.files.readFile({ path: conversationPlanSourcePath({ planId, revision: 1 }) }), { code: "ENOENT" });
    f.state.rejectMarkdown = false;
    const result = await f.resume();
    assert.equal(result.revision, 1);
    assert.equal(result.status, "awaiting_human_approval");
    assert.equal(f.state.calls, 3);
  } finally { await f.close(); }
});

// Simulates the legacy failure boundary: anchor retained before a scope-validation error.
test("a legacy orphan anchor is validated and recovered without another AM invocation", async () => {
  const f = await fixture();
  try {
    f.state.rejectMarkdown = true;
    await assert.rejects(f.planner().createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" }));
    const [session] = await f.sessions.list("CONV-A");
    const planId = session.source_path.split("/").at(-2);
    const path = conversationPlanSourcePath({ planId, revision: 1 });
    const bytes = canonicalizeArchitecturePlanJSON(PLAN);
    await f.files.atomicCreate({ path, content: bytes });
    f.state.rejectMarkdown = false;
    const result = await f.resume();
    assert.equal(result.plan_id, planId);
    assert.equal(f.state.calls, 2);
    assert.equal(await f.files.readFile({ path }), bytes);
    assert.equal(result.run_started, false);
    assert.deepEqual(await f.resume(), result);
  } finally { await f.close(); }
});

// Recovers both retained files after a database failure without rewriting the AM answer.
test("restart indexes byte-identical Markdown after a partial persistence failure", async () => {
  const f = await fixture();
  try {
    f.state.rejectInsert = true;
    await assert.rejects(f.planner().createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" }), { code: "INDEX_UNAVAILABLE" });
    assert.equal(f.store.list().length, 0);
    f.state.rejectInsert = false;
    const result = await f.resume();
    assert.equal(f.state.calls, 2);
    assert.equal(result.revision, 1);
    assert.equal(f.store.list().length, 1);
    assert.equal((await f.store.getRevision({ planId: result.plan_id, revision: 1 })).sha256, result.sha256);
    assert.deepEqual(await f.resume(), result);
  } finally { await f.close(); }
});

// Recovery cannot adopt unrelated Markdown merely because its immutable filename exists.
test("conflicting unindexed Markdown is preserved and never accepted as a revision", async () => {
  const f = await fixture();
  try {
    f.state.rejectInsert = true;
    await assert.rejects(f.planner().createFromConversation({ text: "Create the architecture plan", conversationId: "CONV-A" }));
    const [session] = await f.sessions.list("CONV-A");
    const path = session.source_path.replace("conversation-intake.json", "ke-hoach-r1.md");
    await f.files.atomicWrite({ path, content: "different revision bytes", replace: true });
    f.state.rejectInsert = false;
    await assert.rejects(f.resume(), { code: "PLAN_HASH_MISMATCH" });
    assert.equal(await f.files.readFile({ path }), "different revision bytes");
    assert.equal(f.state.calls, 2);
    assert.equal(f.store.list().length, 0);
  } finally { await f.close(); }
});

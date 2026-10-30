/** Exercises role-bound contract discovery and lossless retrieval without SDK
 * calls, repository discovery, state mutation or fabricated approval evidence. */
import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { createLookupSchemaTool } from "../../src/tools/discovery/lookup-schema-tool.js";
import { AGENT_SCHEMA_CATALOG, agentSchemaEntries } from "../../src/modules/governance/agent-schema-catalog.js";
import { AGENT_DECISION_ACTIONS } from "../../src/modules/governance/agent-decision-schema.js";
import { agentSchemaDocument } from "../../src/modules/governance/agent-schema-document.js";
import { AGENT_ROLE_READMES, agentRoleGuidance } from "../../src/modules/governance/agent-role-guidance.js";
import { parseArchitecturePlanJSON } from "../../src/modules/governance/architecture-plan-json.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createSprintLeaderForgeTools } from "../../src/tools/roles/sprint-leader-forge-tools.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";
import { engineeringToolImplementations } from "../../src/tools/engineering-tool-implementations.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";
import { parseTicketWorkProgress } from "../../src/modules/supervisor/ticket/ticket-work-progress.js";

/** Supplies only Node-issued task identity and the metadata capability; reading
 * a contract must not require access to a project source directory. */
function context(role) {
  return { task_id: "LOOKUP-TEST", capabilities: ["lookup_schema"], agent_identity: { agent_id: `AGENT-${role}`, role } };
}

/** Reassembles all pages as a client would, checking contiguous source offsets
 * and output bytes rather than allowing silent schema truncation. */
async function retrieve(tool, input, identity) {
  let result = await tool.execute(input, identity);
  if (!result.json_fragment) return result;
  let text = "";
  const hash = result.sha256;
  for (;;) {
    assert.equal(result.offset, text.length);
    assert.equal(result.sha256, hash);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 10_000);
    text += result.json_fragment;
    if (result.complete) { assert.equal(text.length, result.total_characters); break; }
    assert.ok(result.next_cursor);
    result = await tool.execute({ ...input, cursor: result.next_cursor }, identity);
  }
  return JSON.parse(text);
}

test("each README maps tasks to resolvable role contracts and delivered guidance has a version hash", async () => {
  assert.equal(new Set(AGENT_SCHEMA_CATALOG.map((entry) => entry.schema_id)).size, AGENT_SCHEMA_CATALOG.length);
  for (const [role, path] of Object.entries(AGENT_ROLE_READMES)) {
    const content = readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
    const entries = agentSchemaEntries(role);
    assert.ok(entries.length);
    const tool = createLookupSchemaTool({ role });
    const catalog = await tool.execute({}, context(role));
    assert.deepEqual(catalog.matches.map((entry) => entry.schema_id), entries.map((entry) => entry.schema_id));
    for (const entry of entries) {
      assert.ok(content.includes(entry.schema_id), `${path} must document ${entry.schema_id}`);
      assert.equal((await retrieve(tool, { schema_id: entry.schema_id }, context(role))).schema_id, entry.schema_id);
    }
    const guidance = agentRoleGuidance(role);
    assert.match(guidance.sha256, /^[a-f0-9]{64}$/);
    assert.ok(guidance.prompt.includes(content));
    assert.equal(agentRoleGuidance(role, { previousHash: guidance.sha256 }).prompt, "");
    assert.ok(agentRoleGuidance(role, { previousHash: "obsolete" }).prompt);
  }
});

test("task and intent discovery point to the response delivery without interpreting agent narrative", async () => {
  const role = "sprint_leader", tool = createLookupSchemaTool({ role });
  const byTask = await tool.execute({ task: "blocker_decision" }, context(role));
  assert.equal(byTask.matches[0].schema_id, "sprint_leader.blocker_decision.v1");
  const byIntent = await tool.execute({ intent: "quyết định" }, context(role));
  assert.ok(byIntent.matches.some((entry) => entry.schema_id === byTask.matches[0].schema_id));
  assert.ok(byIntent.matches.every((entry) => entry.role === role));
  assert.deepEqual((await tool.execute({ task: "unknown_task" }, context(role))).matches, []);
});

test("lookup rejects missing grants, foreign schemas, role overrides, arbitrary paths and malformed cursors", async () => {
  const tool = createLookupSchemaTool({ role: "coder" });
  const c = context("coder");
  await assert.rejects(tool.execute({}, { ...c, capabilities: [] }), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(tool.execute({}, { ...c, task_id: null }), { code: "TOOL_SCOPE_INVALID" });
  await assert.rejects(tool.execute({}, context("reviewer")), { code: "SCHEMA_LOOKUP_FORBIDDEN" });
  await assert.rejects(createLookupSchemaTool().execute({}, context("node")), { code: "SCHEMA_LOOKUP_FORBIDDEN" });
  for (const schema_id of ["reviewer.review_result.v1", "../../secrets", "nonexistent"]) {
    await assert.rejects(tool.execute({ schema_id }, c), { code: "SCHEMA_NOT_AVAILABLE" });
  }
  for (const input of [{ role: "architecture_manager" }, { path: ".env" }, { action: "resolved" }, { cursor: "fake" }]) {
    await assert.rejects(tool.execute(input, c), { code: "SCHEMA_LOOKUP_INPUT_INVALID" });
  }
  await assert.rejects(tool.execute({ schema_id: "coder.review_response.v1", action: "resolved" }, c), { code: "SCHEMA_ACTION_FORBIDDEN" });
  await assert.rejects(tool.execute({ schema_id: "coder.review_response.v1", cursor: "{" }, c), { code: "SCHEMA_CURSOR_INVALID" });
  await assert.rejects(tool.execute({ schema_id: "coder.review_response.v1", cursor: Buffer.from("null").toString("base64url") }, c), { code: "SCHEMA_CURSOR_INVALID" });
});

test("action lookup is role-scoped and pagination cannot be replayed with another role, action or document", async () => {
  const role = "architecture_manager", schema_id = `${role}.blocker_decision.v1`, tool = createLookupSchemaTool({ role });
  const first = await tool.execute({ schema_id }, context(role));
  assert.equal(first.complete, false);
  assert.deepEqual(await retrieve(tool, { schema_id }, context(role)), agentSchemaDocument(agentSchemaEntries(role)[0]));
  const cursor = first.next_cursor;
  await assert.rejects(tool.execute({ schema_id, action: "resolved", cursor }, context(role)), { code: "SCHEMA_CURSOR_INVALID" });
  await assert.rejects(tool.execute({ schema_id: `${role}.architecture_plan.v1`, cursor }, context(role)), { code: "SCHEMA_CURSOR_INVALID" });
  await assert.rejects(createLookupSchemaTool({ role: "sprint_leader" }).execute({ schema_id: "sprint_leader.blocker_decision.v1", cursor }, context("sprint_leader")), { code: "SCHEMA_CURSOR_INVALID" });
  const stale = JSON.parse(Buffer.from(cursor, "base64url").toString());
  stale.fingerprint = "obsolete";
  await assert.rejects(tool.execute({ schema_id, cursor: Buffer.from(JSON.stringify(stale)).toString("base64url") }, context(role)), { code: "SCHEMA_CURSOR_INVALID" });
  const selected = await retrieve(tool, { schema_id, action: "resolved" }, context(role));
  assert.equal(selected.schema.properties.payload.properties.decision.anyOf.length, 1);
  assert.equal(selected.example.payload.decision.action, "resolved");
  await assert.rejects(tool.execute({ schema_id, action: "coder_requested" }, context(role)), { code: "SCHEMA_ACTION_FORBIDDEN" });
});

test("all schema examples validate, including each decision action, without obsolete planner fields or Node-owned draft metadata", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  for (const entry of AGENT_SCHEMA_CATALOG) {
    const actions = entry.task === "blocker_decision" ? AGENT_DECISION_ACTIONS[entry.role] : [undefined];
    for (const action of actions) {
      const result = agentSchemaDocument(entry, { action });
      if (result.schema_format === "forge_field_contract") {
        assert.doesNotThrow(() => parseArchitecturePlanJSON(JSON.stringify(result.example)));
        assert.ok(result.schema.fields.outcomes.item.guardrails);
        continue;
      }
      const validate = ajv.compile(result.schema);
      assert.equal(validate(result.example), true, `${entry.schema_id}/${action}: ${JSON.stringify(validate.errors)}`);
      if (entry.task === "work_progress") assert.doesNotThrow(() => parseTicketWorkProgress(JSON.stringify(result.example)));
      assert.ok(result.rules.some((rule) => rule.includes("no approval")));
      if (entry.draft) {
        const ticket = entry.draft === "sprint" ? result.schema.properties.tickets.items : result.schema;
        for (const field of ["project_id", "roadmap_id", "sprint_id", "provenance", "candidate_files"]) assert.equal(ticket.properties[field], undefined);
        assert.ok(ticket.required.includes("verification_plan"));
        assert.ok(ticket.required.includes("file_budget"));
        assert.equal(ticket.properties.execution_policy.properties.max_review_revisions, undefined);
      }
    }
  }
});

test("runtime metadata lookup remains usable after source budget exhaustion while Stop and identity checks remain active", async () => {
  const governance = createRuntimeToolGovernance();
  const c = governance.createExecutionContext({ ...context("coder"), execution_id: "E", context_budget: { max_calls: 0, max_bytes: 0 } });
  const before = governance.getBudget(c);
  const tool = createLookupSchemaTool({ role: "coder" });
  const result = await governance.dispatch("lookup_schema", {}, c, (input, identity) => tool.execute(input, identity));
  assert.equal(result.role, "coder");
  assert.deepEqual(governance.getBudget(c), before);
  await assert.rejects(governance.dispatch("lookup_schema", {}, { ...c, agent_identity: { role: "architecture_manager" } }, () => assert.fail()), { code: "TOOL_IDENTITY_INVALID" });
  await assert.rejects(governance.dispatch("lookup_schema", {}, { ...c, lifecycle: "CANCELLED" }, () => assert.fail()), { code: "TOOL_EXECUTION_INACTIVE" });
});

test("production wrappers expose executable schema lookup without repository services or discovery receipts", async () => {
  const fileService = { readForIndex: async () => assert.fail("Lookup must not read source"), readFile() {}, atomicWrite() {}, deleteFile() {}, listFiles() {}, listDirectories() {} };
  for (const role of Object.keys(AGENT_ROLE_READMES)) {
    const c = context(role);
    const tools = createOwnerConversationTools({ role, projectRoot: process.cwd(), fileService, context: c });
    assert.ok(tools.definitions.some((entry) => entry.name === "lookup_schema"));
    assert.equal((await tools.registry.lookup_schema.execute({}, c)).role, role);
  }
  const tools = engineeringToolImplementations({ registry: {}, wrap: (tool) => tool, fileService });
  assert.equal((await tools.lookup_schema.execute({}, context("coder"))).role, "coder");
  const receipts = new Map(), paths = new Set();
  const sl = createSprintLeaderForgeTools({ fileService, projectRoot: process.cwd(), profile: { agent_id: "SL", role: "sprint_leader" }, correlationId: "SL-LOOKUP", discoveredPaths: paths, readReceipts: receipts });
  for (let i = 0; i < 21; i++) assert.equal((await sl.registry.lookup_schema.execute({})).role, "sprint_leader");
  assert.equal(paths.size, 0); assert.equal(receipts.size, 0);
  const rv = createReviewerForgeTools({ fileService, projectRoot: process.cwd(), job: { task_id: "T", request_id: "R", correlation_id: "C" }, reviewer: { agent_id: "RV" } });
  assert.equal((await rv.registry.lookup_schema.execute({})).role, "reviewer");
});

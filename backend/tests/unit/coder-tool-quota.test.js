// Verifies that long Coder assignments retain tool access across providers and
// restored execution budgets, without losing mutation receipts, audit counters,
// resource permissions, or lifecycle cancellation at the shared Forge boundary.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";
import { createEditDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { discoveryNotice, recordRead } from "../../src/tools/exploration-state.js";

// Builds a deliberately exhausted historical Coder context to exercise the
// production policy independently of provider-specific prompts and SDK traffic.
function coderContext(provider, overrides = {}) {
  return {
    task_id: `TASK-${provider}`, execution_id: `EXEC-${provider}`,
    agent_identity: { agent_id: `CODER-${provider}`, role: "coder", provider },
    capabilities: ["read_file", "edit_diff", "git_status", "run_check"],
    allowed_prefixes: ["backend/"],
    context_budget: { max_bytes: 1_000_000, max_calls: 1, used_bytes: 1_000_000, used_calls: 20 },
    discovery_budget: 1, allow_discovery_escalation: false,
    exploration_state: { seen_reads: [], unproductive_streak: 3, discovery_count: 100, discovery_limit: 1 },
    ...overrides
  };
}

// Exercises both estimated and actual output overflow with repeated discovery,
// edits and verification results, while checking that audit accounting survives.
for (const provider of ["claude", "anthropic", "codex", "openai", "ollama", "deepseek"]) {
  test(`${provider} Coder tools remain usable beyond byte, call and discovery quotas`, async () => {
    const audits = [];
    const governance = createRuntimeToolGovernance({ eventStore: { append: (event) => audits.push(event) } });
    const current = governance.createExecutionContext(coderContext(provider));
    assert.equal(current.context_budget.max_bytes, null);
    assert.equal(current.context_budget.max_calls, null);
    for (let count = 0; count < 25; count += 1) {
      const notice = await governance.dispatch("read_file", { path: "backend/source.js" }, current, async (_input, context) => {
        recordRead(context, { path: "backend/source.js", window: "1-10" });
        return discoveryNotice(context);
      });
      assert.equal(notice.limit, null);
      assert.equal(notice.suggested_next_action, null);
    }
    for (const tool of ["edit_diff", "git_status", "run_check"]) {
      const result = await governance.dispatch(tool, { path: "backend/source.js", max_chars: 2_000_000 }, current,
        async () => ({ content: "x".repeat(1_000_001) }));
      assert.equal(result.content.length, 1_000_001);
    }
    const budget = governance.getBudget(current);
    assert.ok(budget.used_bytes > 4_000_000);
    assert.equal(budget.used_calls, 48);
    assert.equal(budget.used_tool_calls.length, 4);
    assert.equal(budget.reserved_bytes, 0);
    assert.equal(budget.reserved_calls, 0);
    assert.equal(audits.length, 28);
    assert.ok(audits.every((event) => event.payload.success));
  });
}

// Proves a real source edit returns its success receipt even when an older
// execution already consumed the former quota, avoiding false mutation retries.
test("exhausted Coder quota cannot turn a successful file edit into a tool failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-coder-quota-"));
  try {
    const path = "backend/source.js";
    const before = "// Stores the diagnostic source value.\nexport const value = 1;\n";
    await mkdir(join(root, "backend"));
    await writeFile(join(root, path), before);
    const tool = createEditDiffTool({ fileService: createFileService({ projectRoot: root }) });
    const governance = createRuntimeToolGovernance();
    const current = governance.createExecutionContext(coderContext("claude"));
    const input = { path, before_checksum: `sha256:${createHash("sha256").update(before).digest("hex")}`,
      anchor: "value = 1", replacement: "value = 2" };
    const result = await governance.dispatch("edit_diff", input, current, (args, context) => tool.execute(args, context));
    assert.equal(result.replaced_count, 1);
    assert.equal(result.path, path);
    assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.match(await readFile(join(root, path), "utf8"), /value = 2/);
    assert.deepEqual(current.changed_paths, [path]);
    assert.equal(governance.getBudget(current).used_calls, 21);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Restores an actually persisted exhausted budget through the SQL boundary;
// counter history remains intact while Coder limits stay disabled after reload.
test("persisted exhausted Coder budgets resume without quota changes or counter resets", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const database = {
    run: (sql, params = []) => sqlite.prepare(sql).run(...params),
    all: (sql, params = []) => sqlite.prepare(sql).all(...params)
  };
  try {
    createRuntimeToolGovernance({ database });
    const input = coderContext("codex");
    database.run("INSERT INTO runtime_tool_budget VALUES (?, ?, ?, ?)",
      [input.task_id, input.execution_id, JSON.stringify(input.context_budget), new Date().toISOString()]);
    for (let count = 1; count <= 2; count += 1) {
      const governance = createRuntimeToolGovernance({ database });
      const current = governance.createExecutionContext(input);
      await governance.dispatch("git_status", {}, current, async () => ({ clean: true }));
      const budget = governance.getBudget(current);
      assert.equal(budget.max_bytes, null);
      assert.equal(budget.max_calls, null);
      assert.equal(budget.used_calls, 20 + count);
      assert.ok(budget.used_bytes > 1_000_000);
    }
    assert.equal(database.all("SELECT * FROM runtime_tool_audit").length, 2);
  } finally { sqlite.close(); }
});

// Ensures removing quotas never grants foreign paths, extra tools, replacement
// identities or execution after Stop; underlying tool failures retain identity.
test("Coder quota removal preserves authorization, Stop and original tool errors", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(coderContext("claude"));
  const execute = async () => { throw new Error("Forbidden executor must not run."); };
  await assert.rejects(governance.dispatch("read_file", { path: "outside/source.js" }, current, execute), { code: "TOOL_RESOURCE_FORBIDDEN" });
  await assert.rejects(governance.dispatch("ungranted_tool", {}, current, execute), { code: "TOOL_FORBIDDEN" });
  await assert.rejects(governance.dispatch("read_file", {}, { ...current, agent_identity: { ...current.agent_identity, agent_id: "OTHER" } }, execute), { code: "TOOL_IDENTITY_INVALID" });
  const failure = Object.assign(new Error("Keep the original tool failure."), { code: "CONTENT_TOO_LARGE" });
  await assert.rejects(governance.dispatch("edit_diff", {}, current, async () => { throw failure; }), (error) => error === failure);
  assert.equal(governance.getBudget(current).reserved_calls, 0);
  await assert.rejects(governance.dispatch("read_file", {}, { ...current, lifecycle: "CANCELLED" }, execute), { code: "TOOL_EXECUTION_INACTIVE" });
});

// Keeps non-Coder quota policy intact and prevents caller-provided flags from
// granting an unrelated role the Coder exemption.
test("non-Coder roles retain their Node-issued quotas", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(coderContext("claude", {
    agent_identity: { agent_id: "REVIEWER", role: "reviewer", provider: "claude" },
    context_budget: { max_bytes: 1, max_calls: 1, unlimited: true }, exploration_enabled: false
  }));
  assert.equal(current.exploration_enabled, true);
  await assert.rejects(governance.dispatch("git_status", {}, current, async () => ({ clean: true })), { code: "CONTEXT_BUDGET_EXCEEDED" });
});

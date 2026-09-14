import assert from "node:assert/strict";
import test from "node:test";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";

function context(overrides = {}) {
  return {
    task_id: "TASK-1",
    execution_id: "EXEC-1",
    agent_identity: "builder",
    capabilities: ["read_code"],
    allowed_resources: { allowed_file_paths: ["src/a.js"] },
    retrieval_budget: { max_bytes: 20, max_calls: 1 },
    lifecycle: "RUNNING",
    ...overrides
  };
}

test("governance enforces identity, capability, scope, and lifecycle", () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context());
  assert.throws(() => governance.authorize("write_file", current), (error) => error.code === "TOOL_FORBIDDEN");
  assert.throws(() => governance.authorize("read_code", { ...current, execution_scope: { task_id: "OTHER" } }), (error) => error.code === "TOOL_SCOPE_INVALID");
  assert.throws(() => governance.authorize("read_code", { ...current, lifecycle: "COMPLETED" }), (error) => error.code === "TOOL_EXECUTION_INACTIVE");
});

test("reserve/commit is concurrency-safe and charges once", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ retrieval_budget: { max_bytes: 20, max_calls: 1 } }));
  const first = governance.reserveRetrieval(current, { tool: "read_code", resource: "src/a.js", estimatedBytes: 10 });
  const second = governance.reserveRetrieval(current, { tool: "write_code", resource: "src/a.js", estimatedBytes: 10 });
  const [one, two] = await Promise.allSettled([first, second]);
  assert.equal([one, two].filter((item) => item.status === "fulfilled").length, 1);
  const reservation = one.status === "fulfilled" ? one.value : two.value;
  await governance.commitRetrieval(current, reservation, { bytes: 8 });
  assert.deepEqual(governance.getBudget(current), { max_bytes: 20, max_calls: 1, used_bytes: 8, used_calls: 1, reserved_bytes: 0, reserved_calls: 0, used_tool_calls: ["read_code"] });
});

test("dispatch counts distinct tool kinds, not invocations", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["read_code", "search_code", "read_file"], retrieval_budget: { max_bytes: 1000000, max_calls: 2 } }));
  const read = async () => ({ content: "hello" });
  await governance.dispatch("read_code", {}, current, read);
  await governance.dispatch("read_code", {}, current, read);
  await governance.dispatch("search_code", {}, current, read);
  const budget = governance.getBudget(current);
  assert.equal(budget.used_tool_calls.length, 2, "two distinct tool kinds consumed the two call slots");
  await assert.rejects(() => governance.dispatch("read_file", {}, current, read), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
});

test("exploration state persists across dispatches within one execution", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["search_code"], retrieval_budget: { max_bytes: 1000000, max_calls: 5 } }));
  const seen = [];
  await governance.dispatch("search_code", { query: "a" }, current, async (_input, toolContext) => {
    seen.push(toolContext.exploration_state.unproductive_streak);
    toolContext.exploration_state.unproductive_streak += 1;
    return { matches: [] };
  });
  await governance.dispatch("search_code", { query: "a" }, current, async (_input, toolContext) => {
    seen.push(toolContext.exploration_state.unproductive_streak);
    return { matches: [] };
  });
  assert.deepEqual(seen, [0, 1]);
  const fresh = governance.createExecutionContext(context({ execution_id: "EXEC-2", capabilities: ["search_code"] }));
  assert.equal(fresh.exploration_state.unproductive_streak, 0, "a new execution starts with fresh exploration state");
  assert.notEqual(fresh.exploration_state, current.exploration_state);
});

test("discovery budget refuses further exploration until an edit unlocks verification", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["search_code", "read_file", "write_diff", "edit_diff"], retrieval_budget: { max_bytes: 1000000, max_calls: 20 }, discovery_budget: 4 }));
  // Unproductive executor (mirrors what recordSearch does for empty/looping
  // searches): a non-zero streak blocks the one budget escalation.
  const explore = async (_input, toolContext) => {
    toolContext.exploration_state.unproductive_streak += 1;
    return { matches: [] };
  };
  for (let i = 0; i < 4; i += 1) await governance.dispatch("search_code", { query: `q${i}` }, current, explore);
  await assert.rejects(() => governance.dispatch("search_code", { query: "q4" }, current, explore), (error) => error.code === "EXPLORATION_BUDGET_EXHAUSTED");
  await assert.rejects(() => governance.dispatch("read_file", { path: "src/a.js" }, current, async () => ({ content: "x" })), (error) => error.code === "EXPLORATION_BUDGET_EXHAUSTED");
  await governance.dispatch("edit_diff", { path: "src/a.js", anchor: "a", replacement: "b" }, current, async () => ({ replaced_count: 1 }));
  await governance.dispatch("read_file", { path: "src/a.js" }, current, async () => ({ content: "edited" }), );
  const budget = governance.getBudget(current);
  assert.equal(budget.used_tool_calls.includes("search_code"), true);
});

test("discovery budget escalates once for a productive agent but never twice", async () => {
  const governance = createRuntimeToolGovernance();
  // Every search returns a new path, so the streak stays at 0 (productive).
  const paths = Array.from({ length: 20 }, (_, i) => `src/file${i}.js`);
  const current = governance.createExecutionContext(context({ capabilities: ["search_code", "read_file"], retrieval_budget: { max_bytes: 1000000, max_calls: 30 }, discovery_budget: 4 }));
  let call = 0;
  const explore = async () => ({ matches: [{ path: paths[call++] }] });
  await governance.dispatch("search_code", { query: "q0" }, current, explore);
  await governance.dispatch("search_code", { query: "q1" }, current, explore);
  await governance.dispatch("search_code", { query: "q2" }, current, explore);
  await governance.dispatch("search_code", { query: "q3" }, current, explore);
  // Budget 4 exhausted, but productive → one escalation to 6 (4 + ceil(4*0.5)).
  // The escalation boundary call does not itself increment discovery_count, so
  // the count reaches 6 on q5 and the refusal lands on q6.
  await governance.dispatch("search_code", { query: "q4" }, current, explore);
  await governance.dispatch("search_code", { query: "q5" }, current, explore);
  await governance.dispatch("search_code", { query: "q6" }, current, explore);
  await assert.rejects(() => governance.dispatch("search_code", { query: "q7" }, current, explore), (error) => error.code === "EXPLORATION_BUDGET_EXHAUSTED");
});

test("discovery budget never escalates for an unproductive agent", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["search_code"], retrieval_budget: { max_bytes: 1000000, max_calls: 30 }, discovery_budget: 4 }));
  // Every call leaves a non-zero streak (mirrors what recordSearch does for
  // empty/looping searches). assertDiscoveryBudget runs before the executor,
  // so by the budget boundary the streak is already > 0 and escalation is
  // refused — the 4th call gets the hard exhaustion.
  const unproductive = async (_input, toolContext) => {
    toolContext.exploration_state.unproductive_streak = 3;
    return { matches: [] };
  };
  for (let i = 0; i < 4; i += 1) await governance.dispatch("search_code", { query: `empty${i}` }, current, unproductive);
  await assert.rejects(() => governance.dispatch("search_code", { query: "empty4" }, current, unproductive), (error) => error.code === "EXPLORATION_BUDGET_EXHAUSTED");
});

test("createExecutionContext honors a per-ticket discovery_budget", () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["search_code"], discovery_budget: 4 }));
  assert.equal(current.exploration_state.discovery_limit, 4);
  const fresh = governance.createExecutionContext(context({ capabilities: ["search_code"], execution_id: "EXEC-2" }));
  assert.equal(fresh.exploration_state.discovery_limit, 8, "default limit applies without an override");
});

test("commit_changes and report_done are exempt from budget accounting", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ capabilities: ["read_code", "commit_changes", "report_done"], retrieval_budget: { max_bytes: 1000000, max_calls: 1 } }));
  await governance.dispatch("read_code", {}, current, async () => ({ content: "hello" }));
  const result = await governance.dispatch("commit_changes", {}, current, async (_input, toolContext) => {
    assert.equal(toolContext.context_budget, undefined);
    return { sha: "SHA-1" };
  });
  assert.equal(result.sha, "SHA-1");
  const report = await governance.dispatch("report_done", {}, current, async () => "recorded");
  assert.equal(report, "recorded");
  const budget = governance.getBudget(current);
  assert.equal(budget.used_tool_calls.includes("commit_changes"), false);
  assert.equal(budget.used_tool_calls.includes("report_done"), false);
});

test("dispatch owns accounting and does not double-charge legacy tool context", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ retrieval_budget: { max_bytes: 100, max_calls: 2 } }));
  const result = await governance.dispatch("read_code", {}, current, async (_input, toolContext) => {
    assert.equal(toolContext.context_budget, undefined);
    return { content: "hello" };
  });
  assert.equal(result.content, "hello");
  assert.equal(governance.getBudget(current).used_calls, 1);
});


test("rejects reused or cross-execution reservations and actual overflow", async () => {
  const governance = createRuntimeToolGovernance();
  const current = governance.createExecutionContext(context({ retrieval_budget: { max_bytes: 10, max_calls: 2 } }));
  const other = governance.createExecutionContext(context({ execution_id: "EXEC-2", retrieval_budget: { max_bytes: 10, max_calls: 2 } }));
  const reservation = await governance.reserveRetrieval(current, { tool: "read_code", resource: "src/a.js", estimatedBytes: 2 });
  await assert.rejects(() => governance.commitRetrieval(other, reservation, { bytes: 1 }), (error) => error.code === "TOOL_RESERVATION_INVALID");
  await assert.rejects(() => governance.commitRetrieval(current, reservation, { bytes: 20 }), (error) => error.code === "CONTEXT_BUDGET_EXCEEDED");
  await governance.releaseRetrieval(current, reservation);
  await assert.rejects(() => governance.releaseRetrieval(current, reservation), (error) => error.code === "TOOL_RESERVATION_INVALID");
});

test("restores persisted budget when a governance service is recreated", async () => {
  const rows = new Map();
  const database = { run(sql, params = []) { if (sql.includes("CREATE TABLE") || sql.includes("CREATE INDEX")) return {}; if (sql.includes("INSERT INTO runtime_tool_budget")) rows.set(`${params[0]}:${params[1]}`, params[2]); return {}; }, all(sql, params = []) { if (sql.includes("SELECT budget_json FROM runtime_tool_budget")) { const value = rows.get(`${params[0]}:${params[1]}`); return value ? [{ budget_json: value }] : []; } return []; } };
  const first = createRuntimeToolGovernance({ database });
  const current = first.createExecutionContext(context({ retrieval_budget: { max_bytes: 20, max_calls: 2 } }));
  const reservation = await first.reserveRetrieval(current, { tool: "read_code", resource: "src/a.js", estimatedBytes: 2 });
  await first.commitRetrieval(current, reservation, { bytes: 7 });
  const restored = createRuntimeToolGovernance({ database });
  const resumed = restored.createExecutionContext(context({ retrieval_budget: { max_bytes: 999, max_calls: 999 } }));
  assert.deepEqual(restored.getBudget(resumed), { max_bytes: 20, max_calls: 2, used_bytes: 7, used_calls: 1, reserved_bytes: 0, reserved_calls: 0, used_tool_calls: ["read_code"] });
});

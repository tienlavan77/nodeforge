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
  const second = governance.reserveRetrieval(current, { tool: "read_code", resource: "src/a.js", estimatedBytes: 10 });
  const [one, two] = await Promise.allSettled([first, second]);
  assert.equal([one, two].filter((item) => item.status === "fulfilled").length, 1);
  const reservation = one.status === "fulfilled" ? one.value : two.value;
  await governance.commitRetrieval(current, reservation, { bytes: 8 });
  assert.deepEqual(governance.getBudget(current), { max_bytes: 20, max_calls: 1, used_bytes: 8, used_calls: 1, reserved_bytes: 0, reserved_calls: 0 });
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
  assert.deepEqual(restored.getBudget(resumed), { max_bytes: 20, max_calls: 2, used_bytes: 7, used_calls: 1, reserved_bytes: 0, reserved_calls: 0 });
});

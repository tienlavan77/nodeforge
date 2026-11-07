// Verifies bounded parallel Read-Only Explorer delegation without touching the project working tree.
import test from "node:test";
import assert from "node:assert/strict";
import { createDelegateSubagentTool, READ_ONLY_EXPLORER_TOOLS } from "../../src/tools/discovery/delegate-subagent-tool.js";

test("delegate_subagent runs a valid batch in parallel and preserves partial success", async () => {
  const started = [];
  const tool = createDelegateSubagentTool({ executeTask: async (task, child) => {
    started.push(task.id);
    assert.deepEqual(child.tools, READ_ONLY_EXPLORER_TOOLS);
    assert.equal(child.exploration_enabled, false);
    if (task.id === "bad") throw Object.assign(new Error("timeout"), { code: "SDK_REQUEST_TIMEOUT" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { summary: `summary-${task.id}`, observed_files: [{ path: "src/shared.js", sha256: "sha256:" + "a".repeat(64), symbols_read: [task.id] }] };
  } });
  const context = { agent_identity: { agent_id: "parent" }, execution_id: "exec" };
  const result = await tool.execute({ tasks: [{ id: "one", objective: "inspect one" }, { id: "bad", objective: "inspect bad" }, { id: "two", objective: "inspect two" }] }, context);
  assert.deepEqual(started.sort(), ["bad", "one", "two"]);
  assert.equal(result.status, "partial_success");
  assert.equal(result.tasks_completed, 2);
  assert.equal(result.observed_files.length, 1);
  assert.deepEqual(result.tasks.find((task) => task.id === "bad").error, { code: "SDK_REQUEST_TIMEOUT", message: "timeout" });
});

test("delegate_subagent derives an isolated read-only child context and rejects unsafe paths", async () => {
  let childContext;
  const tool = createDelegateSubagentTool({ executeTask: async (task, context) => {
    childContext = context;
    assert.deepEqual(context.tools, READ_ONLY_EXPLORER_TOOLS);
    assert.equal(context.read_only_enforced, true);
    assert.equal(context.execution_id, "parent-execution:sub:inspect");
    assert.equal(context.agent_identity.agent_id, "parent-agent:sub:inspect");
    assert.deepEqual(context.allowed_prefixes, ["src/"]);
    assert.throws(() => context.assertToolAllowed("edit_diff"), { code: "SUBAGENT_TOOL_FORBIDDEN" });
    return { summary: "ok", observed_files: [{ path: "src/shared.js", sha256: "sha256:" + "b".repeat(64), symbols_read: ["Shared"] }] };
  } });
  const result = await tool.execute({ tasks: [{ id: "inspect", objective: "inspect", paths: ["src/shared.js"] }] }, {
    task_id: "parent-task", execution_id: "parent-execution", agent_identity: { agent_id: "parent-agent", role: "system_engineer" }, allowed_prefixes: ["src/"]
  });
  assert.equal(result.tasks_completed, 1);
  assert.equal(result.observed_files[0].child_execution_id, "parent-execution:sub:inspect");
  assert.equal(result.observed_files[0].parent_execution_id, "parent-execution");
  assert.equal(typeof result.observed_files[0].observed_at, "string");
  assert.equal(result.observed_files[0].source_tool, "read_file");
  assert.equal(childContext.subagent_depth, 1);
  await assert.rejects(() => tool.execute({ tasks: [{ id: "bad", objective: "inspect", paths: ["../outside"] }] }, {}), /safe relative paths/);
});

test("delegate_subagent validates before spawning and enforces the per-turn quota", async () => {
  let spawned = 0;
  const tool = createDelegateSubagentTool({ executeTask: async () => { spawned += 1; return {}; } });
  await assert.rejects(() => tool.execute({ tasks: [{ id: "dup", objective: "one" }, { id: "dup", objective: "two" }] }, {}), /unique safe identifiers/);
  assert.equal(spawned, 0);
  await assert.rejects(() => tool.execute({ tasks: [{ id: "one", objective: "one" }] }, { subagent_reservations: 4 }), /quota exceeded/);
  assert.equal(spawned, 0);
  await assert.rejects(() => tool.execute({ tasks: [{ id: "../escape", objective: "unsafe" }] }, {}), /unique safe identifiers/);
});

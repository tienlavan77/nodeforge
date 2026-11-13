// Verifies bounded parallel Read-Only Explorer delegation without touching the project working tree.
import test from "node:test";
import assert from "node:assert/strict";
import { createDelegateSubagentTool, READ_ONLY_EXPLORER_TOOLS } from "../../src/tools/discovery/delegate-subagent-tool.js";

test("delegate_subagent runs a valid batch in parallel and preserves partial success", async () => {
  const started = [];
  const tool = createDelegateSubagentTool({ executeTask: async (task, child) => {
    started.push(task.id);
    assert.deepEqual(child.tools, READ_ONLY_EXPLORER_TOOLS);
    assert.equal(child.exploration_enabled, true);
    assert.equal(child.exploration_state.discovery_limit, 8);
    assert.equal(child.exploration_state.allow_escalation, false);
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
    context.observed_files = [{ path: "src/shared.js", sha256: "sha256:" + "a".repeat(64), symbols_read: ["Collected"], symbol_map: [{ name: "Collected", kind: "function", start_line: 1, end_line: 5, summary: "Long summary that should not bloat JSON output" }], source_tool: "Read" }];
    return { summary: "ok", observed_files: [{ path: "src/shared.js", sha256: "sha256:" + "b".repeat(64), symbols_read: ["Untrusted"] }] };
  } });
  const result = await tool.execute({ tasks: [{ id: "inspect", objective: "inspect", paths: ["src/shared.js"] }] }, {
    task_id: "parent-task", execution_id: "parent-execution", agent_identity: { agent_id: "parent-agent", role: "system_engineer" }, allowed_prefixes: ["src/"]
  });
  assert.equal(result.tasks_completed, 1);
  assert.equal(result.observed_files[0].child_execution_id, "parent-execution:sub:inspect");
  assert.equal(result.observed_files[0].parent_execution_id, "parent-execution");
  assert.equal(typeof result.observed_files[0].observed_at, "string");
  assert.equal(result.observed_files[0].source_tool, "Read");
  assert.equal(result.observed_files[0].sha256, "sha256:" + "a".repeat(64));
  assert.deepEqual(result.observed_files[0].symbols_read, ["Collected"]);
  assert.deepEqual(result.observed_files[0].symbols, ["Collected"]);
  assert.equal(result.observed_files[0].symbol_map, undefined);
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

test("asynchronous delegate_subagent returns delegation_id immediately, reports progress, and collects at barrier", async () => {
  const gates = new Map();
  const tool = createDelegateSubagentTool({
    asynchronous: true,
    executeTask: async (task) => {
      await new Promise((resolve) => { gates.set(task.id, resolve); });
      return {
        summary: `done-${task.id}`,
        observed_files: [{ path: `src/${task.id}.js`, sha256: "sha256:" + "c".repeat(64), symbols_read: [task.id] }],
        subagent_usage: { input_tokens: 10 }
      };
    }
  });
  const context = { conversation_id: "conv-1", execution_id: "exec-1", agent_identity: { agent_id: "se-1" } };
  const accepted = await tool.execute({ tasks: [{ id: "fast", objective: "explore fast" }, { id: "slow", objective: "explore slow" }] }, context);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.delegation_id, "exec-1:delegation:1");
  assert.equal(accepted.tasks_started, 2);

  gates.get("fast")();
  await new Promise((resolve) => setTimeout(resolve, 10));

  const midStatus = await tool.statusTool.execute({ delegation_id: accepted.delegation_id }, context);
  assert.equal(midStatus.status, "running");
  assert.equal(midStatus.tasks_completed, 1);

  const partial = await tool.collectTool.execute({ delegation_id: accepted.delegation_id, wait: false }, context);
  assert.equal(partial.status, "partial");
  assert.equal(partial.tasks_completed, 1);

  setTimeout(() => gates.get("slow")(), 10);
  const collected = await tool.collectTool.execute({ delegation_id: accepted.delegation_id, wait: true, timeout_ms: 1000 }, context);
  assert.equal(collected.status, "completed");
  assert.equal(collected.tasks_completed, 2);
  assert.equal(collected.observed_files.length, 2);
  assert.equal(context.observed_files.length, 2);
  assert.equal(context.subagent_usage, 20);
});

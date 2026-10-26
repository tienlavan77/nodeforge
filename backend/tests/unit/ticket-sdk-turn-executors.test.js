/** Runs the production Claude and Codex ticket adapters across a phase boundary
 * to verify the provider session, original profile and completion receipts survive. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeforgeTaskExecutors } from "../../src/modules/supervisor/nodeforge-task-executors.js";

// The two SDKs must execute their next turn on the original provider session.
for (const provider of ["claude", "codex"]) test(`${provider} executor resumes a discovery yield before completing the ticket`, async (context) => {
  const root = await mkdtemp(join(tmpdir(), "forge-sdk-turns-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], saved = [];
  const gateway = { execute: async (input) => {
    calls.push(input);
    const first = calls.length === 1;
    await input.onSessionReady("ORIGINAL-SESSION");
    const tools = first ? ["read_file"] : ["edit_diff", "commit_changes", "report_done"];
    if (provider === "codex") for (const tool of tools) await input.onEvent({ type: "item.completed", item: { id: `${calls.length}-${tool}`, type: "mcp_tool_call", server: "forge", tool, status: "completed" } });
    const text = first ? JSON.stringify({ kind: "work_progress", subject: "Discovery complete", payload: { status: "discovery_complete", next_action: "implement", summary: "Source found", remaining_work: ["Implement the ticket"] }, evidence: [] }) : "Ticket completed";
    return { turn_completed: true, text, messages: tools.map((name) => ({ type: "assistant", message: { content: [{ type: "tool_use", id: `${calls.length}-${name}`, name: `mcp__forge__${name}` }] } })) };
  } };
  const executors = createNodeforgeTaskExecutors({ ...(provider === "claude" ? { claudeSdkGateway: gateway } : { codexSdkGateway: gateway }),
    toolRegistry: { read_file: { execute: async () => ({}) }, write_diff: { execute: async () => ({}) }, edit_diff: { execute: async () => ({}) }, commit_changes: { execute: async () => ({}) }, report_done: { execute: async () => ({}) } },
    runtimeGovernance: { createExecutionContext: (input) => input }, projectRoot: root, projectLogger: () => {}, checkpoints: { save: async (value) => { saved.push(structuredClone(value)); } } });
  const selected = { agent_id: "ORIGINAL-CODER", role: "coder", provider };
  const request = { project_id: "PROJECT", task_id: "TASK-PHASE", request_id: "REQ-PHASE", correlation_id: "CORR-PHASE", ticket: { title: "Implement", objective: "Implement", acceptance_criteria: ["Works"] }, payload: { execution_id: "RUN", direct_code: true } };
  const result = await (provider === "claude" ? executors.runToolTicket : executors.runCodexTask)(selected, request);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].agentId, "ORIGINAL-CODER");
  assert.equal(provider === "claude" ? calls[1].resumeSessionId : calls[1].resumeThreadId, "ORIGINAL-SESSION");
  assert.deepEqual(result.tool_events.map((event) => event.tool), ["read_file", "edit_diff", "commit_changes", "report_done"]);
  assert.ok(saved.some((checkpoint) => checkpoint.sdk_turn_progress?.status === "discovery_complete"));
  const progress = saved.find((checkpoint) => checkpoint.sdk_turn_progress?.message_ref);
  const message = JSON.parse(await readFile(join(root, progress.sdk_turn_progress.message_ref), "utf8"));
  assert.equal(message.kind, "work_progress"); assert.equal(message.context.execution_id, "RUN");
  assert.match(calls[0].prompt, /Exact work_progress payload JSON Schema/);
  assert.match(calls[1].prompt, /Node accepted work_progress/);
});

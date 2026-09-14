import assert from "node:assert/strict";
import test from "node:test";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";

function workerWith(jobStub) {
  const sent = [];
  const worker = createSenderWorker({
    queue: { claim: async () => jobStub, ack: async () => {}, reject: async () => {} },
    agentRegistry: { resolve: () => ({ adapter: { send: async ({ tools }) => { sent.push(tools); return { type: "session.result", summary: "done" }; } } }) },
    eventBus: { publish: async () => {} },
    toolRegistry: {}
  });
  return { worker, sent };
}

test("attempt request exposes retrieval tool definitions for advertised capabilities", async () => {
  const { worker, sent } = workerWith({
    task_id: "TASK-T", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1", attempt: 1, agent_id: "builder",
    payload: { type: "task", step_id: 1, expected_output: { type: "code_needed", transport: "function_tool" }, execution_context: { capabilities: ["select_code_graph_candidates", "search_code", "read_code", "read_transcript_blocks"], task_id: "TASK-T" }, transcript_blocks: [] }
  });
  await worker.processOnce();
  const names = sent[0].map((tool) => tool.name);
  for (const name of ["read_transcript_blocks", "select_code_graph_candidates", "search_code", "read_code"]) assert.equal(names.includes(name), true, `missing ${name}`);
});

test("session request excludes capability-gated Forge tools not advertised", async () => {
  const { worker, sent } = workerWith({
    task_id: "TASK-T", supervisor_id: "SUP-1", request_id: "REQ-3", correlation_id: "CORR-3", attempt: 1, agent_id: "builder",
    payload: { type: "task", step_id: 1, expected_output: { type: "code_needed", transport: "function_tool" }, execution_context: { capabilities: ["read_transcript_blocks", "read_code"], task_id: "TASK-T" }, transcript_blocks: [] }
  });
  await worker.processOnce();
  const names = sent[0].map((tool) => tool.name);
  assert.equal(names.includes("read_code"), true);
  assert.equal(names.includes("search_code"), false);
  assert.equal(names.includes("select_code_graph_candidates"), false);
  assert.equal(names.includes("write_diff"), false);
  // No response function tools: sessions are terminated by report_done only.
  assert.equal(names.includes("planning"), false);
  assert.equal(names.includes("submit_code_response"), false);
  assert.equal(names.includes("code_needed"), false);
});

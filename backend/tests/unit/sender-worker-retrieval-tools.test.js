import assert from "node:assert/strict";
import test from "node:test";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";
import { readTranscriptBlocksDefinition, searchCodeDefinition, readCodeDefinition } from "../../src/tools/index.js";

function workerWith(jobStub) {
  const sent = [];
  const worker = createSenderWorker({
    queue: { claim: async () => jobStub, ack: async () => {}, reject: async () => {} },
    agentRegistry: { resolve: () => ({ adapter: { send: async ({ tools }) => { sent.push(tools); return { type: "code_needed", files_requested: ["a.js"] }; } } }) },
    eventBus: { publish: async () => {} },
    toolRegistry: {}
  });
  return { worker, sent };
}

test("R2 request exposes retrieval tool definitions for advertised capabilities", async () => {
  const { worker, sent } = workerWith({
    task_id: "TASK-T", supervisor_id: "SUP-1", request_id: "REQ-1", correlation_id: "CORR-1", attempt: 1, agent_id: "builder",
    payload: { type: "planning", step_id: 2, expected_output: { type: "planning", transport: "function_tool" }, execution_context: { capabilities: ["select_code_graph_candidates", "search_code", "read_code", "read_transcript_blocks"], task_id: "TASK-T" }, transcript_blocks: [], plan: [] }
  });
  await worker.processOnce();
  const names = sent[0].map((tool) => tool.name);
  assert.equal(names.filter((name) => name === "planning").length, 1);
  for (const name of ["read_transcript_blocks", "select_code_graph_candidates", "search_code", "read_code"]) assert.equal(names.includes(name), true, `missing ${name}`);
});

test("R3 request exposes only read_code and read_transcript_blocks retrieval tools", async () => {
  const { worker, sent } = workerWith({
    task_id: "TASK-T", supervisor_id: "SUP-1", request_id: "REQ-3", correlation_id: "CORR-3", attempt: 1, agent_id: "builder",
    payload: { type: "code_provide", step_id: 3, expected_output: { type: "submit_code_response", transport: "function_tool" }, execution_context: { capabilities: ["read_transcript_blocks", "read_code"], task_id: "TASK-T" }, transcript_blocks: [], plan: [] }
  });
  await worker.processOnce();
  const names = sent[0].map((tool) => tool.name);
  assert.equal(names.includes("submit_code_response"), true);
  assert.equal(names.includes("read_code"), true);
  assert.equal(names.includes("search_code"), false);
  assert.equal(names.includes("select_code_graph_candidates"), false);
});

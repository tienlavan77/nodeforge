import test from "node:test";
import assert from "node:assert/strict";
import { createSenderWorker } from "../../src/modules/supervisor/sender-worker.js";
import { stage1AgentTools } from "../../src/modules/workflows/stage1-agent-tools.js";

function responseEnvelope(type, payload) {
  return {
    request_id: "22222222-2222-4222-8222-222222222222",
    parent_id: "11111111-1111-4111-8111-111111111111",
    type,
    role: "agent",
    payload,
    timestamp: "2026-09-07T00:00:00.000Z"
  };
}

function harness({ responses, registry = {} } = {}) {
  const events = [];
  const acked = [];
  const queue = {
    async claim() { return responses.length ? queue.job : null; },
    job: {
      id: "JOB-1", task_id: "FORGE-LOOP-001", supervisor_id: "SUP-1",
      request_id: "11111111-1111-4111-8111-111111111111",
      correlation_id: "CORR-1", attempt: 1,
      agent_id: "builder",
      payload: { type: "task", step_id: 1 }
    },
    async ack(id) { acked.push(id); }
  };
  let sent = 0;
  const adapter = { async send() { return responses[sent++] ?? responses.at(-1); } };
  const registryCalls = [];
  const toolRegistry = Object.fromEntries(Object.entries(registry).map(([name, result]) => [name, {
    async execute(input) { registryCalls.push({ name, input }); return result; }
  }]));
  const worker = createSenderWorker({
    queue,
    agentRegistry: { resolve: () => ({ adapter }) },
    eventBus: { async publish(event) { events.push(event); } },
    toolRegistry
  });
  return { worker, events, acked, registryCalls, sent: () => sent };
}

test("code_needed response tool terminates the turn and reaches the supervisor", async () => {
  const response = responseEnvelope("code_needed", { files_requested: ["src/a.js"], reason: "inspect" });
  const h = harness({ responses: [response] });
  const event = await h.worker.processOnce();
  assert.equal(event.type, "agent.response.received");
  assert.equal(event.payload.response.type, "code_needed");
  assert.deepEqual(h.registryCalls, []);
});

test("planning response tool is not routed through the tool registry", async () => {
  const response = responseEnvelope("planning", { plan: [{ path: "src/a.js", action: "MODIFY" }] });
  const h = harness({ responses: [response] });
  const event = await h.worker.processOnce();
  assert.equal(event.type, "agent.response.received");
  assert.equal(event.payload.response.type, "planning");
  assert.deepEqual(h.registryCalls, []);
});

test("submit_code_response response tool does not trigger TOOL_NOT_FOUND", async () => {
  const response = responseEnvelope("submit_code_response", { files: [{ path: "src/a.js", format: "full_content", content: "x" }] });
  const h = harness({ responses: [response] });
  const event = await h.worker.processOnce();
  assert.equal(event.type, "agent.response.received");
  assert.equal(event.payload.response.type, "submit_code_response");
  assert.deepEqual(h.registryCalls, []);
});

test("retrieval tool calls still execute through the tool registry then return the final response", async () => {
  const retrieval = { output: [{ type: "function_call", call_id: "call-1", name: "read_transcript_blocks", arguments: JSON.stringify({ block_ids: ["round-1"] }) }] };
  const final = responseEnvelope("code_needed", { files_requested: ["src/a.js"] });
  const h = harness({ responses: [retrieval, final], registry: { read_transcript_blocks: { blocks: [] } } });
  const event = await h.worker.processOnce();
  assert.equal(h.registryCalls.length, 1);
  assert.equal(h.registryCalls[0].name, "read_transcript_blocks");
  assert.equal(event.type, "agent.response.received");
  assert.equal(event.payload.response.type, "code_needed");
});

test("unknown non-response tool still fails with TOOL_NOT_FOUND", async () => {
  const retrieval = { output: [{ type: "function_call", call_id: "call-1", name: "mystery_tool", arguments: "{}" }] };
  const h = harness({ responses: [retrieval] });
  const event = await h.worker.processOnce();
  assert.equal(event.type, "agent.response.failed");
  assert.equal(event.payload.error.code, "TOOL_NOT_FOUND");
});

test("response tools declared in stage1AgentTools all terminate the turn", async () => {
  const responseNames = ["code_needed", "planning", "submit_code_response", "patch_repair_response", "usage_needed", "no_wiring_needed"];
  for (const name of responseNames) {
    const response = responseEnvelope(name, {});
    const h = harness({ responses: [response] });
    const event = await h.worker.processOnce();
    assert.equal(event.type, "agent.response.received", `${name} should succeed`);
  }
});

test("stage1AgentTools still defines the response tool set", () => {
  const names = stage1AgentTools.map((tool) => tool.name);
  assert.ok(names.includes("code_needed"));
  assert.ok(names.includes("planning"));
  assert.ok(names.includes("submit_code_response"));
});

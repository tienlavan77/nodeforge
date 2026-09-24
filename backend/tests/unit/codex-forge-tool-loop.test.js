import assert from "node:assert/strict";
import test from "node:test";
import { createCodexForgeToolLoop } from "../../src/modules/agent/codex-forge-tool-loop.js";

const SECRET = "sk-super-secret-gateway-token";

function definitions() {
  return [
    { name: "search_code", description: "Search", input_schema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false } },
    { name: "read_file", description: "Read", input_schema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false } },
    { name: "write_diff", description: "Write", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, before_checksum: { type: ["string", "null"] } }, additionalProperties: false } },
    { name: "run_test", description: "Test", input_schema: { type: "object", properties: {}, additionalProperties: false } },
    { name: "commit_changes", description: "Commit", input_schema: { type: "object", properties: { message: { type: "string" } }, additionalProperties: false } },
    { name: "report_done", description: "Done", input_schema: { type: "object", properties: { summary: { type: "string" } }, additionalProperties: false } }
  ];
}

// Drives a deterministic six-tool sequence: search_code -> read_file ->
// write_diff -> run_test -> commit_changes -> report_done, then asserts the
// loop forwarded each call through the governed registry with the right context.
test("runs the six-tool Forge sequence through agentGateway function-calls", async () => {
  const order = ["search_code", "read_file", "write_diff", "run_test", "commit_changes", "report_done"];
  const requests = [];
  const executed = [];
  const contexts = [];
  let callId = 0;
  const agentGateway = {
    request: async ({ agentId, payload, correlationId, tools }) => {
      requests.push({ agentId, correlationId, messages: structuredClone(payload.messages), tools });
      const next = order[requests.length - 1];
      callId += 1;
      if (!next) return { payload: { text: "all done", tool_use: null } };
      return { payload: { tool_use: { id: `call_${callId}`, name: next, input: next === "report_done" ? { summary: "Six tools executed." } : { probe: next } } } };
    }
  };
  const registry = Object.fromEntries(order.map((name) => [name, {
    execute: async (input, context) => {
      executed.push({ name, input });
      contexts.push(context);
      if (name === "report_done") return { summary: input.summary };
      if (name === "read_file") return { path: "backend/tool-lab-target.txt", sha256: "sha256:abc" };
      return { ok: true, tool: name };
    }
  }]));
  const context = { task_id: "T-1", execution_id: "T-1:R-1", session_id: "T-1:R-1", credential: SECRET };
  const events = [];
  const loop = createCodexForgeToolLoop({ agentGateway });
  const result = await loop.run({
    agentId: "codex-1",
    correlationId: "CORR-1",
    prompt: "Run the six-tool Forge test.",
    definitions: definitions(),
    registry,
    context,
    onToolEvent: async (event) => events.push(event)
  });

  assert.equal(result.rounds, 6);
  assert.equal(result.text, "Six tools executed.");
  assert.deepEqual(executed.map((entry) => entry.name), order);
  assert.deepEqual(events.map((event) => event.tool), order);
  assert.ok(events.every((event) => event.status === "completed"));

  // Each request forwards the Responses-shape tools (type:"function" + parameters).
  const tools = requests[0].tools;
  assert.equal(tools.length, 6);
  assert.ok(tools.every((tool) => tool.type === "function"));
  assert.ok(tools.every((tool) => tool.parameters && tool.parameters.type === "object"));
  assert.ok(tools.some((tool) => tool.name === "search_code"));

  // Round N>1 replays the function_call + function_call_output transcript.
  const round2 = requests[1].messages;
  assert.equal(round2[0].role, "user");
  assert.equal(round2[1].type, "function_call");
  assert.equal(round2[1].name, "search_code");
  assert.equal(round2[2].type, "function_call_output");
  assert.equal(JSON.parse(round2[2].output).tool, "search_code");

  // Governance context reaches every execute() unchanged.
  assert.ok(contexts.every((entry) => entry.task_id === "T-1" && entry.execution_id === "T-1:R-1"));

  // The credential never appears in the wire transcript or tool outputs.
  const wire = JSON.stringify(requests.map((entry) => entry.messages));
  assert.equal(wire.includes(SECRET), false);
});

test("throws CODEX_MCP_TOOL_CALLS_MISSING when the gateway exposes no tools", async () => {
  const loop = createCodexForgeToolLoop({ agentGateway: { request: async () => ({ payload: { text: "Forge MCP tools are not available.", tool_use: null } }) } });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry: { search_code: { execute: async () => ({}) } }, context: {} });
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.tool_events, []);
  assert.equal(result.text, "Forge MCP tools are not available.");
});

test("coerces a string 'null' before_checksum to JSON null for write_diff", async () => {
  let received;
  const agentGateway = {
    request: async ({ payload }) => {
      if (payload.messages.length === 1) return { payload: { tool_use: { id: "c1", name: "write_diff", input: { path: "backend/tool-lab-target.txt", content: "tool-lab\n", before_checksum: null } } } };
      return { payload: { tool_use: { id: "c2", name: "report_done", input: { summary: "done" } } } };
    }
  };
  const registry = {
    write_diff: { execute: async (input) => { received = input; return { ok: true }; } },
    report_done: { execute: async (input) => ({ summary: input.summary }) }
  };
  const loop = createCodexForgeToolLoop({ agentGateway });
  await loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry, context: {} });
  assert.equal(received.before_checksum, null);
  assert.equal(typeof received.before_checksum, "object");
});

test("returns an authorizeTool denial as a tool error the model can retry", async () => {
  const events = [];
  let writeCalls = 0;
  const agentGateway = {
    request: async ({ payload }) => {
      if (payload.messages.length === 1) return { payload: { tool_use: { id: "c1", name: "write_diff", input: { path: "outside/target.txt", content: "x\n", before_checksum: null } } } };
      return { payload: { text: "stopped", tool_use: null } };
    }
  };
  const registry = {
    write_diff: { execute: async () => { writeCalls += 1; const error = new Error("Path is outside the allowed prefixes."); error.code = "TOOL_AUTHORIZATION_DENIED"; throw error; } }
  };
  const loop = createCodexForgeToolLoop({ agentGateway });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry, context: {}, onToolEvent: async (event) => events.push(event) });
  assert.equal(writeCalls, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].error.error_code, "TOOL_AUTHORIZATION_DENIED");
  assert.equal(result.tool_events[0].error.error_code, "TOOL_AUTHORIZATION_DENIED");
});

test("rejects a tool name outside the exposed allowlist", async () => {
  const events = [];
  const agentGateway = { request: async () => ({ payload: { tool_use: { id: "c1", name: "shell_exec", input: { command: "rm -rf /" } } } }) };
  const registry = { shell_exec: { execute: async () => ({ pwned: true }) } };
  const loop = createCodexForgeToolLoop({ agentGateway });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry, context: {}, onToolEvent: async (event) => events.push(event) });
  assert.equal(events[0].status, "failed");
  assert.equal(events[0].error.error_code, "TOOL_NOT_ALLOWED");
  assert.equal(result.rounds, 1);
});

test("chains cache config and previous_response_id across rounds", async () => {
  const payloads = [];
  const agentGateway = {
    request: async ({ payload }) => {
      payloads.push(structuredClone(payload));
      if (payloads.length === 1) return { payload: { response_id: "resp_1", tool_use: { id: "c1", name: "report_done", input: { summary: "done" } } } };
      return { payload: { text: "done" } };
    }
  };
  const registry = { report_done: { execute: async (input) => ({ summary: input.summary }) } };
  const loop = createCodexForgeToolLoop({ agentGateway });
  await loop.run({ agentId: "codex-1", correlationId: "CORR-CACHE", prompt: "Run.", definitions: definitions(), registry, context: { task_id: "T-CACHE", ticket: { project_id: "P-1" } } });
  assert.equal(payloads[0].cache_config.prompt_cache_key, "forge:P-1:T-CACHE");
  assert.equal(payloads[0].previous_response_id, "store_only");
});

test("throws when maxRounds is exceeded without report_done", async () => {
  let calls = 0;
  const agentGateway = { request: async () => { calls += 1; return { payload: { tool_use: { id: `c${calls}`, name: "search_code", input: { query: "loop" } } } }; } };
  const registry = { search_code: { execute: async () => ({ ok: true }) } };
  const loop = createCodexForgeToolLoop({ agentGateway });
  await assert.rejects(
    () => loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry, context: {}, maxRounds: 3 }),
    (error) => error.code === "CODEX_TOOL_LOOP_ROUND_LIMIT" && calls === 3
  );
});

test("stops the loop when report_done returns a summary", async () => {
  const agentGateway = { request: async () => ({ payload: { tool_use: { id: "c1", name: "report_done", input: { summary: "Six tools completed." } } } }) };
  const registry = { report_done: { execute: async (input) => ({ summary: input.summary }) } };
  const loop = createCodexForgeToolLoop({ agentGateway });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-1", prompt: "Run.", definitions: definitions(), registry, context: {} });
  assert.equal(result.rounds, 1);
  assert.equal(result.text, "Six tools completed.");
  assert.equal(result.tool_events.at(-1).tool, "report_done");
});

test("aggregates usage rounds without leaking run-local state outside scope", async () => {
  const logs = [];
  const agentGateway = {
    request: async ({ payload }) => {
      if (payload.messages.length === 1) return { payload: { usage: { input_tokens: 100, output_tokens: 5, cached_tokens: 25 }, tool_use: { id: "c1", name: "report_done", input: { summary: "done" } } } };
      return { payload: { text: "done", usage: { input_tokens: 1, output_tokens: 1 } } };
    }
  };
  const registry = { report_done: { execute: async (input) => ({ summary: input.summary }) } };
  const loop = createCodexForgeToolLoop({ agentGateway, projectLogger: (entry) => logs.push(entry) });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-USAGE", prompt: "Run.", definitions: definitions(), registry, context: { task_id: "T-USAGE" } });
  assert.deepEqual(result.usage, { rounds: 1, input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 25 });
  assert.equal(logs[0].payload.cache_hit_rate, 0.25);
  assert.equal(logs[0].payload.round, 1);
  assert.equal(logs[0].payload.agent_id, "codex-1");
});

// Retries after a failed report_done instead of stopping: a COMMIT_MISSING
// rejection from the checkpoint gate returns to the model, which commits and
// reports again in the same run.
test("continues the loop when report_done fails and stops after a retry succeeds", async () => {
  let reports = 0;
  const agentGateway = {
    request: async ({ payload }) => {
      const calls = payload.messages.filter((message) => message.type === "function_call").length;
      if (calls === 0) return { payload: { tool_use: { id: "c1", name: "report_done", input: { summary: "skip commit" } } } };
      if (calls === 1) return { payload: { tool_use: { id: "c2", name: "commit_changes", input: { message: "commit before report" } } } };
      return { payload: { tool_use: { id: "c3", name: "report_done", input: { summary: "committed then reported" } } } };
    }
  };
  const registry = {
    commit_changes: { execute: async () => ({ sha: "abc123" }) },
    report_done: {
      execute: async (input) => {
        reports += 1;
        if (reports === 1) { const error = new Error("Changes are present but commit_changes has not succeeded after the last edit."); error.code = "COMMIT_MISSING"; throw error; }
        return { summary: input.summary };
      }
    }
  };
  const loop = createCodexForgeToolLoop({ agentGateway });
  const result = await loop.run({ agentId: "codex-1", correlationId: "CORR-RETRY", prompt: "Run.", definitions: definitions(), registry, context: {} });
  assert.equal(reports, 2);
  assert.equal(result.rounds, 3);
  assert.equal(result.text, "committed then reported");
  assert.equal(result.tool_events.at(-1).tool, "report_done");
  assert.equal(result.tool_events.at(-1).status, "completed");
  assert.equal(result.tool_events[0].status, "failed");
});

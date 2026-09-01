import assert from "node:assert/strict";
import test from "node:test";

import { createAgentGateway } from "../../src/modules/agent/agent-gateway.js";

test("routes a request through configured gateway and preserves correlation without exposing credential", async () => {
  let call;
  const gateway = createAgentGateway({
    configuration: { getById: () => config() },
    credentialResolver: async (reference) => { assert.equal(reference, "env:ARCH_KEY"); return "real-secret"; },
    transport: async (input) => { call = input; return { status: "accepted", payload: { result: "ok" } }; }
  });
  const result = await gateway.request({ agentId: "architecture-manager", correlationId: "CORR-146", payload: { text: "Plan" } });
  assert.equal(call.credential, "real-secret");
  assert.equal(call.correlation_id, "CORR-146");
  assert.equal(result.correlation_id, "CORR-146");
  assert(!JSON.stringify(result).includes("real-secret"));
});

test("supports connection health, rejects disabled/invalid profiles, and handles failure", async () => {
  const gateway = createAgentGateway({ configuration: { getById: (id) => id === "disabled" ? { ...config(), agent_id: id, enabled: false } : id === "invalid" ? { ...config(), agent_id: id, gateway_url: "http://insecure" } : config() }, credentialResolver: () => "secret", transport: async ({ operation }) => ({ status: operation === "health" ? "healthy" : "ok", payload: {} }) });
  assert.deepEqual(await gateway.testConnection("architecture-manager"), { agent_id: "architecture-manager", status: "CONNECTED", gateway_url: "https://gateway.example.test/architecture" });
  await assert.rejects(() => gateway.request({ agentId: "disabled", correlationId: "CORR", payload: {} }), /disabled/);
  await assert.rejects(() => gateway.request({ agentId: "invalid", correlationId: "CORR", payload: {} }), /invalid/);
  const failing = createAgentGateway({ configuration: { getById: () => config() }, credentialResolver: () => "secret", transport: async () => { throw new Error("secret upstream details"); } });
  await assert.rejects(() => failing.request({ agentId: "architecture-manager", correlationId: "CORR", payload: {} }), (error) => error.message === "Agent Gateway request failed for architecture-manager.");
});

test("enforces timeout and unavailable credential without leaking details", async () => {
  const gateway = createAgentGateway({ configuration: { getById: () => config() }, credentialResolver: () => "secret", timeoutMs: 5, transport: ({ signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => { const error = new Error("aborted"); error.name = "AbortError"; reject(error); })) });
  await assert.rejects(() => gateway.request({ agentId: "architecture-manager", correlationId: "CORR", payload: {} }), /timed out/);
  const missing = createAgentGateway({ configuration: { getById: () => config() }, credentialResolver: () => undefined, transport: async () => ({}) });
  await assert.rejects(() => missing.request({ agentId: "architecture-manager", correlationId: "CORR", payload: {} }), /unavailable/);
});

test("maps an OpenAI-compatible Responses API payload to a safe Agent response", async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ id: "resp_1", status: "completed", output: [{ content: [{ type: "output_text", text: "Real architecture response" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = createAgentGateway({ configuration: { getById: () => ({ ...config(), gateway_url: "https://gateway.example.test/v1/responses" }) }, credentialResolver: () => "secret" });
    const result = await gateway.request({ agentId: "architecture-manager", correlationId: "CORR-148", payload: { text: "Design the service" } });
    assert.equal(request.url, "https://gateway.example.test/v1/responses");
    const requestBody = JSON.parse(request.options.body);
    assert.equal(requestBody.model, "gpt-5.6-terra");
    assert.equal(requestBody.input, "Design the service");
    assert.equal(Array.isArray(requestBody.tools), true);
    assert.equal(result.payload.text, "Real architecture response");
    assert.equal(result.correlation_id, "CORR-148");
    assert(!JSON.stringify(result).includes("secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("forwards explicit Stage-1 tools instead of the legacy agent_tool", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;
  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "resp_tools", status: "completed", output: [{ type: "function_call", name: "code_needed", arguments: JSON.stringify({ files_requested: ["src/example.js"], reason: "inspect" }) }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = createAgentGateway({ configuration: { getById: () => ({ ...config(), provider: "codex", gateway_url: "https://gateway.example.test/v1/responses" }) }, credentialResolver: () => "secret" });
    await gateway.request({ agentId: "architecture-manager", correlationId: "CORR-TOOLS", payload: { request_id: "11111111-1111-4111-8111-111111111111", expected_output: { type: "submit_code_response" }, text: "inspect" }, tools: [{ type: "function", name: "code_needed", description: "Request source", parameters: { type: "object" } }, { type: "function", name: "submit_code_response", description: "Submit code", parameters: { type: "object" } }] });
    assert.deepEqual(requestBody.tools.map((tool) => tool.name), ["code_needed", "submit_code_response"]);
    assert(!requestBody.tools.some((tool) => tool.name === "agent_tool"));
  } finally { globalThis.fetch = originalFetch; }
});

test("forwards ordered Responses API stream deltas without credential leakage", async () => {
  const gateway = createAgentGateway({ configuration: { getById: () => ({ ...config(), gateway_url: "https://gateway.example.test/v1/responses" }) }, credentialResolver: () => "secret", streamTransport: async function* () { yield { text: "Hello " }; yield { text: "stream", response_id: "resp_stream" }; } });
  const chunks = [];
  for await (const chunk of gateway.stream({ agentId: "architecture-manager", correlationId: "CORR-149", payload: { text: "hello" } })) chunks.push(chunk);
  assert.deepEqual(chunks.map(({ text }) => text).filter(Boolean), ["Hello ", "stream"]);
  assert.equal(chunks.at(-1).response_id, "resp_stream");
  assert(chunks.every((chunk) => chunk.correlation_id === "CORR-149"));
  assert(!JSON.stringify(chunks).includes("secret"));
});

test("forwards normalized text events with task correlation", async () => {
  const events = [];
  const gateway = createAgentGateway({ configuration: { getById: () => config() }, credentialResolver: () => "secret", streamTransport: async function* () { yield { text: "one" }; yield { text: "two" }; } });
  const chunks = [];
  for await (const chunk of gateway.stream({ agentId: "architecture-manager", correlationId: "CORR-EVENT", payload: { task_id: "TASK-EVENT", text: "hello" }, eventSink: (event) => events.push(event) })) chunks.push(chunk);
  assert.deepEqual(chunks.map(({ text }) => text).filter(Boolean), ["one", "two"]);
  assert.deepEqual(events.map((event) => event.event_type), ["agent.text_stream", "agent.text_stream"]);
  assert.deepEqual(events.map((event) => event.payload.chunk), ["one", "two"]);
  assert.deepEqual(events.map((event) => event.task_id), ["TASK-EVENT", "TASK-EVENT"]);
});

function config() { return { agent_id: "architecture-manager", agent_name: "Architecture Manager", gateway_url: "https://gateway.example.test/architecture", credential_ref: "env:ARCH_KEY", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" }; }

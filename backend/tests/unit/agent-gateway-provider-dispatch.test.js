import assert from "node:assert/strict";
import test from "node:test";

import { createAgentGateway } from "../../src/modules/agent/agent-gateway.js";

test("gateway dispatches to correct adapter per provider and preserves correlation", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url, headers: options.headers, body });
    if (options.headers["x-api-key"]) return new Response(JSON.stringify({ id: "anthro_1", content: [{ type: "text", text: "claude text" }] }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ id: "codex_1", output_text: "codex text" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const cfg = (provider, url, model) => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: url, credential_ref: "env:KEY", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider, model });
    const secret = "super-secret-value";
    const gateway = createAgentGateway({
      configuration: { getById: (id) => {
        if (id === "architecture-manager") return cfg("codex", "https://gateway.example.test/v1/responses", "gpt-5.6-terra");
        if (id === "builder") return cfg("anthropic", "https://api.anthropic.com/v1/messages", "claude-sonnet-4-5-20251001");
        if (id === "reviewer") return cfg("custom", "https://custom.example.test/v1/chat/completions", "custom-model");
        return cfg("codex", "https://gateway.example.test/v1/responses", "");
      } },
      credentialResolver: () => secret,
      timeoutMs: 5000
    });

    const r1 = await gateway.request({ agentId: "architecture-manager", correlationId: "CORR-1", payload: { text: "t1" } });
    assert.equal(r1.correlation_id, "CORR-1");
    assert.equal(r1.payload.text, "codex text");
    assert(!JSON.stringify(r1).includes(secret));

    const r2 = await gateway.request({ agentId: "builder", correlationId: "CORR-2", payload: { text: "t2" } });
    assert.equal(r2.correlation_id, "CORR-2");
    assert.equal(r2.payload.text, "claude text");
    assert(!JSON.stringify(r2).includes(secret));

    const r3 = await gateway.request({ agentId: "reviewer", correlationId: "CORR-3", payload: { text: "t3" } });
    assert.equal(r3.correlation_id, "CORR-3");
    assert.ok(typeof r3.payload.text === "string" && r3.payload.text.length > 0);

    const anthropicCall = calls.find((c) => c.headers["x-api-key"]);
    assert(anthropicCall);
    assert.equal(anthropicCall.headers["x-api-key"], secret);
    assert(!anthropicCall.headers.authorization);

    const codexCall = calls.find((c) => c.headers.authorization);
    assert(codexCall);
    assert.equal(codexCall.headers.authorization, `Bearer ${secret}`);
  } finally { globalThis.fetch = originalFetch; }
});

test("gateway preserves correlation_id through adapter stream and normalizes deltas", async () => {
  const gateway = createAgentGateway({
    configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider: "codex", model: "" }) },
    credentialResolver: () => "secret",
    adapterRegistry: () => ({ request: async () => ({ status: "completed", payload: { text: "ok" } }), stream: async function* () { yield { text: "Hello " }; yield { text: "world", response_id: "resp_1" }; } }),
    timeoutMs: 5000
  });
  const chunks = [];
  for await (const chunk of gateway.stream({ agentId: "architecture-manager", correlationId: "CORR-STREAM", payload: { text: "hi" } })) chunks.push(chunk);
  assert(chunks.every((c) => c.correlation_id === "CORR-STREAM"));
  assert.deepEqual(chunks.filter((c) => c.text).map((c) => c.text), ["Hello ", "world"]);
  assert.equal(chunks.find((c) => c.completed)?.response_id, "resp_1");
  assert(!JSON.stringify(chunks).includes("secret"));
});

test("gateway forwards Anthropic and OpenAI adapter deltas to one event shape", async () => {
  for (const provider of ["anthropic", "codex"]) {
    const events = [];
    const gateway = createAgentGateway({
      configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider }) },
      credentialResolver: () => "secret",
      adapterRegistry: () => ({ request: async () => ({ status: "completed", payload: { text: "ok" } }), stream: async function* () { yield { text: "delta-1" }; yield { text: "delta-2" }; } })
    });
    const chunks = [];
    for await (const chunk of gateway.stream({ agentId: "architecture-manager", correlationId: `CORR-${provider}`, payload: { task_id: `TASK-${provider}`, text: "hi" }, eventSink: (event) => events.push(event) })) chunks.push(chunk);
    assert.deepEqual(chunks.filter((chunk) => chunk.text).map((chunk) => chunk.text), ["delta-1", "delta-2"]);
    assert.deepEqual(events.map((event) => event.event_type), ["agent.text_stream", "agent.text_stream"]);
    assert.deepEqual(events.map((event) => event.task_id), [`TASK-${provider}`, `TASK-${provider}`]);
    assert(events.every((event) => Object.keys(event.payload).every((key) => ["chunk", "agent_id", "sequence", "done"].includes(key))));
  }
});

test("gateway maps provider-specific errors and timeouts without leaking credential", async () => {
  const secret = "leak-secret-xyz";
  const failingAdapter = { request: async () => { throw new Error(`upstream failed with ${secret}`); }, stream: async function* () { yield* []; throw new Error(`stream failed ${secret}`); } };
  const timeoutAdapter = {
    request: ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); })),
    stream: ({ signal }) => ({ [Symbol.asyncIterator]: async function* () { yield* []; await new Promise((_, reject) => signal.addEventListener("abort", () => { const e = new Error("aborted"); e.name = "AbortError"; reject(e); })); } })
  };

  const gatewayFail = createAgentGateway({
    configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider: "codex" }) },
    credentialResolver: () => secret,
    adapterRegistry: () => failingAdapter,
    timeoutMs: 100
  });
  await assert.rejects(() => gatewayFail.request({ agentId: "architecture-manager", correlationId: "CORR-E", payload: { text: "t" } }), (err) => {
    assert(!err.message.includes(secret));
    assert.match(err.message, /request failed/);
    return true;
  });

  const gatewayTimeout = createAgentGateway({
    configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider: "codex" }) },
    credentialResolver: () => secret,
    adapterRegistry: () => timeoutAdapter,
    timeoutMs: 5
  });
  await assert.rejects(() => gatewayTimeout.request({ agentId: "architecture-manager", correlationId: "CORR-T", payload: { text: "t" } }), (err) => {
    assert(!err.message.includes(secret));
    assert.match(err.message, /timed out/);
    return true;
  });
});

test("gateway uses per-agent model over env default", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.NODE_AGENT_MODEL;
  process.env.NODE_AGENT_MODEL = "env-model";
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "r1", output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const gateway = createAgentGateway({
      configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider: "codex", model: "per-agent-model" }) },
      credentialResolver: () => "s",
      timeoutMs: 5000
    });
    await gateway.request({ agentId: "architecture-manager", correlationId: "C1", payload: { text: "hi" } });
    assert.equal(captured.model, "per-agent-model");
    const gateway2 = createAgentGateway({
      configuration: { getById: () => ({ agent_id: "architecture-manager", agent_name: "AM", gateway_url: "https://gateway.example.test/v1/responses", credential_ref: "env:K", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z", provider: "codex", model: "" }) },
      credentialResolver: () => "s",
      timeoutMs: 5000
    });
    await gateway2.request({ agentId: "architecture-manager", correlationId: "C2", payload: { text: "hi" } });
    assert.equal(captured.model, "env-model");
  } finally { process.env.NODE_AGENT_MODEL = originalEnv; globalThis.fetch = originalFetch; }
});

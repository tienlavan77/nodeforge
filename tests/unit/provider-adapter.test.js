import assert from "node:assert/strict";
import test from "node:test";

import * as codex from "../../src/modules/agent/provider-adapters/codex-adapter.js";
import * as anthropic from "../../src/modules/agent/provider-adapters/anthropic-adapter.js";
import * as custom from "../../src/modules/agent/provider-adapters/custom-adapter.js";
import * as claude from "../../src/modules/agent/provider-adapters/claude-adapter.js";
import * as openai from "../../src/modules/agent/provider-adapters/openai-adapter.js";
import { getAdapter } from "../../src/modules/agent/provider-adapters/index.js";
import { createAgentGateway } from "../../src/modules/agent/agent-gateway.js";

test("provider adapters expose request and stream contract", () => {
  for (const adapter of [codex, anthropic, custom, openai]) {
    assert.equal(typeof adapter.request, "function");
    assert.equal(typeof adapter.stream, "function");
  }
  assert.equal(getAdapter("codex"), codex);
  assert.equal(getAdapter("openai"), openai);
  assert.equal(getAdapter("claude"), claude);
  assert.equal(getAdapter("anthropic"), anthropic);
  assert.equal(getAdapter("custom"), custom);
  assert.equal(getAdapter("claude"), claude);
  assert.equal(getAdapter(undefined), codex);
  assert.equal(getAdapter("unknown"), codex);
});

test("claude provider uses the Devquote Messages gateway contract", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: "claude_1", content: [{ type: "text", text: "Claude reply" }] }), { status: 200 });
  };
  try {
    const result = await claude.request({ url: "https://sv.devquote.shop", credential: "secret", payload: { text: "hello" }, model: "claude-haiku-4-5", correlationId: "CORR-CLAUDE" });
    assert.equal(captured.url, "https://sv.devquote.shop/v1/messages");
    assert.equal(captured.headers.authorization, "Bearer secret");
    assert.equal(captured.body.model, "claude-haiku-4-5");
    assert.equal(result.payload.text, "Claude reply");
    assert(!JSON.stringify(result).includes("secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("codex adapter maps Responses API request to normalized response with model and correlation", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: "resp_codex_1", status: "completed", output: [{ content: [{ type: "output_text", text: "Codex reply" }] }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await codex.request({ url: "https://gateway.example.test/v1/responses", credential: "sk-codex-secret", payload: { text: "Hello codex" }, model: "gpt-5.6-terra", correlationId: "CORR-CODEX", signal: undefined });
    assert.equal(captured.url, "https://gateway.example.test/v1/responses");
    assert.equal(captured.headers.authorization, "Bearer sk-codex-secret");
    assert.equal(captured.headers["x-correlation-id"], "CORR-CODEX");
    assert.deepEqual(captured.body, { model: "gpt-5.6-terra", input: "Hello codex" });
    assert.equal(result.payload.text, "Codex reply");
    assert.equal(result.payload.response_id, "resp_codex_1");
    assert(!JSON.stringify(result).includes("sk-codex-secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("codex adapter normalizes legacy singular response endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ id: "resp_legacy", output_text: "ok" }), { status: 200 });
  };
  try {
    await codex.request({ url: "https://gateway.example.test/v1/response", credential: "secret", payload: { text: "ping" }, model: "gpt-5.6-sol", correlationId: "CORR-LEGACY" });
    assert.equal(requestedUrl, "https://gateway.example.test/v1/responses");
  } finally { globalThis.fetch = originalFetch; }
});

test("codex adapter expands a base gateway URL to the Responses endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl;
  globalThis.fetch = async (url) => {
    requestedUrl = url;
    return new Response(JSON.stringify({ id: "resp_base", output_text: "ok" }), { status: 200 });
  };
  try {
    await codex.request({ url: "https://sv.devquote.shop", credential: "secret", payload: { text: "ping" }, model: "gpt-5.6-sol", correlationId: "CORR-BASE" });
    assert.equal(requestedUrl, "https://sv.devquote.shop/v1/responses");
  } finally { globalThis.fetch = originalFetch; }
});

test("codex adapter uses per-agent model over env fallback", async () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = process.env.NODE_AGENT_MODEL;
  process.env.NODE_AGENT_MODEL = "env-model";
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "r1", output_text: "ok" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    await codex.request({ url: "https://gateway.example.test/v1/responses", credential: "s", payload: { text: "t" }, model: "per-agent-model", correlationId: "C1" });
    assert.equal(captured.model, "per-agent-model");
    await codex.request({ url: "https://gateway.example.test/v1/responses", credential: "s", payload: { text: "t" }, model: undefined, correlationId: "C2" });
    assert.equal(captured.model, "env-model");
  } finally { process.env.NODE_AGENT_MODEL = originalEnv; globalThis.fetch = originalFetch; }
});

test("codex adapter streams ordered deltas via Responses SSE", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const sse = 'data: {"type":"response.output_text.delta","delta":"Hello "}\n\ndata: {"type":"response.output_text.delta","delta":"stream"}\n\ndata: {"type":"response.completed","response":{"id":"resp_stream"}}\n\n';
    return new Response(new TextEncoder().encode(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const chunks = [];
    for await (const chunk of codex.stream({ url: "https://gateway.example.test/v1/responses", credential: "secret", payload: { text: "hi" }, model: "gpt-5.6-terra", correlationId: "CORR-S" })) chunks.push(chunk);
    assert.deepEqual(chunks.filter((c) => c.text).map((c) => c.text), ["Hello ", "stream"]);
    assert.equal(chunks.find((c) => c.response_id)?.response_id, "resp_stream");
    assert(!JSON.stringify(chunks).includes("secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("anthropic adapter sends x-api-key and anthropic-version headers with model and messages", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, headers: options.headers, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: "msg_123", content: [{ type: "text", text: "Anthropic reply" }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await anthropic.request({ url: "https://api.anthropic.com/v1/messages", credential: "sk-ant-secret", payload: { text: "Hello claude" }, model: "claude-sonnet-4-5-20251001", correlationId: "CORR-ANT" });
    assert.equal(captured.headers["x-api-key"], "sk-ant-secret");
    assert.equal(captured.headers["anthropic-version"], "2023-06-01");
    assert.equal(captured.headers["x-correlation-id"], "CORR-ANT");
    assert.equal(captured.body.model, "claude-sonnet-4-5-20251001");
    assert.deepEqual(captured.body.messages, [{ role: "user", content: "Hello claude" }]);
    assert.equal(result.payload.text, "Anthropic reply");
    assert.equal(result.payload.response_id, "msg_123");
    assert(!captured.headers.authorization);
    assert(!JSON.stringify(result).includes("sk-ant-secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("anthropic adapter streams content_block_delta deltas", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    const sse = 'data: {"type":"content_block_delta","delta":{"text":"Hello "}}\n\ndata: {"type":"content_block_delta","delta":{"text":"claude"}}\n\ndata: {"type":"message_stop","message":{"id":"msg_stream"}}\n\n';
    return new Response(new TextEncoder().encode(sse), { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    const chunks = [];
    for await (const chunk of anthropic.stream({ url: "https://api.anthropic.com/v1/messages", credential: "secret", payload: { text: "hi" }, model: "claude-sonnet-4-5-20251001", correlationId: "CORR-A" })) chunks.push(chunk);
    assert.deepEqual(chunks.filter((c) => c.text).map((c) => c.text), ["Hello ", "claude"]);
    assert(!JSON.stringify(chunks).includes("secret"));
  } finally { globalThis.fetch = originalFetch; }
});

test("custom adapter handles OpenAI chat completions fallback", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (_url, options) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: "chat_1", choices: [{ message: { content: "Custom reply" } }] }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await custom.request({ url: "https://custom.example.test/v1/chat/completions", credential: "sk-custom", payload: { text: "hello" }, model: "custom-model", correlationId: "CORR-C" });
    assert.equal(captured.model, "custom-model");
    assert.deepEqual(captured.messages, [{ role: "user", content: "hello" }]);
    assert.equal(result.payload.text, "Custom reply");
  } finally { globalThis.fetch = originalFetch; }
});

test("custom adapter delegates to codex for /responses URLs", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return new Response(JSON.stringify({ id: "resp_custom", output_text: "via responses" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await custom.request({ url: "https://custom.example.test/v1/responses", credential: "s", payload: { text: "hi" }, model: "m", correlationId: "C" });
    assert(captured.url.endsWith("/responses"));
    assert.deepEqual(captured.body, { model: "m", input: "hi" });
    assert.equal(result.payload.text, "via responses");
  } finally { globalThis.fetch = originalFetch; }
});

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

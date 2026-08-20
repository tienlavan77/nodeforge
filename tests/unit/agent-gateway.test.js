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

function config() { return { agent_id: "architecture-manager", agent_name: "Architecture Manager", gateway_url: "https://gateway.example.test/architecture", credential_ref: "env:ARCH_KEY", enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" }; }

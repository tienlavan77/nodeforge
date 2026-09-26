import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSettingsService } from "../../src/application/agent-settings-service.js";

test("saves masked Agent Settings through Profile/Configuration and tests connection via Gateway", async () => {
  let profile;
  const profiles = { getAll: () => profile ? [profile] : [], getById: (id) => id === profile?.agent_id ? profile : undefined, create: (value) => (profile = structuredClone(value)), update: (value) => (profile = structuredClone(value)), delete: () => true };
  let synced = 0; let tested = 0;
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => { synced += 1; } }, gateway: { testConnection: async () => { tested += 1; return { status: "CONNECTED", gateway_url: profile.gateway_url }; } } });
  const saved = service.save({ agent_id: "55555555-5555-4555-8555-555555555555", agent_name: "Builder", role: "coder", provider: "custom", gateway_url: "https://gateway.example.test/builder", enabled: true, api_key: "secret" });
  assert.equal(saved.api_key_masked, "********"); assert.equal(profile.api_key, undefined); assert.equal(synced, 1);
  assert.equal((await service.testConnection("55555555-5555-4555-8555-555555555555")).status, "CONNECTED"); assert.equal(tested, 1);
  assert.equal(profile.team, "Backend");

  const updated = service.save({ agent_id: profile.agent_id, agent_name: "Builder", role: "coder", team: "Security", gateway_url: profile.gateway_url, enabled: true });
  assert.equal(profile.team, "Security");
  assert.equal(updated.team, "Security");
  assert.equal(service.get(profile.agent_id).team, "Security");
});

// Confirms Anthropic profiles use the Claude SDK for connection tests.
test("tests Anthropic connectivity through the Claude SDK", async () => {
  const profile = { agent_id: "66666666-6666-4666-8666-666666666666", provider: "anthropic", role: "architecture_manager", enabled: true, status: "ready", gateway_url: "https://gateway.example.test/anthropic" };
  let request;
  const service = createAgentSettingsService({
    profiles: { getAll: () => [profile], getById: () => profile, create: () => profile, update: () => profile, delete: () => true },
    configuration: { sync: () => {} },
    gateway: { testConnection: async () => { throw new Error("Anthropic must not use generic gateway"); } },
    claudeSdkGateway: { execute: async (value) => { request = value; return { text: "OK" }; } }
  });
  const result = await service.testConnection(profile.agent_id);
  assert.equal(result.status, "CONNECTED");
  assert.equal(request.agentId, profile.agent_id);
  assert.equal(request.correlationId, `CONNECTION-${profile.agent_id}`);
});
// Confirms OpenAI Connect uses the same SDK gateway and profile as conversation turns.
test("tests OpenAI connectivity through its conversation SDK", async () => {
  const profile = { agent_id: "55555555-5555-4555-8555-555555555555", provider: "openai", model: "gpt-6-sol", gateway_url: "https://gateway.example.test/v1/responses" };
  let sdkRequest;
  const service = createAgentSettingsService({ profiles: { getAll: () => [profile], getById: () => profile, create: () => profile, update: () => profile, delete: () => true }, configuration: { sync: () => {} }, gateway: { testConnection: async () => { throw new Error("Wrong transport"); } }, openaiSdkGateway: { execute: async (request) => { sdkRequest = request; return { text: "OK" }; } } });
  const result = await service.testConnection(profile.agent_id);
  assert.equal(result.status, "CONNECTED");
  assert.equal(sdkRequest.agent, profile);
  assert.equal(sdkRequest.correlationId, `CONNECTION-${profile.agent_id}`);
});

test("creates and returns an agent profile team", () => {
  let profile;
  const profiles = { getAll: () => profile ? [profile] : [], getById: (id) => id === profile?.agent_id ? profile : undefined, create: (value) => (profile = structuredClone(value)), update: (value) => (profile = structuredClone(value)), delete: () => true };
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => {} }, gateway: { testConnection: async () => ({ status: "CONNECTED" }) } });
  const created = service.create({ agent_id: "88888888-8888-4888-8888-888888888888", role: "reviewer", team: "Frontend", gateway_url: "https://gateway.example.test/reviewer" });
  assert.equal(profile.team, "Frontend");
  assert.equal(created.team, "Frontend");
  assert.equal(service.list()[0].team, "Frontend");
});

test("rejects invalid agent teams", () => {
  const profiles = { getAll: () => [], getById: () => undefined, create: () => {}, update: () => {}, delete: () => true };
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => {} }, gateway: { testConnection: async () => ({ status: "CONNECTED" }) } });
  const base = { agent_id: "99999999-9999-4999-8999-999999999999", role: "coder", gateway_url: "https://gateway.example.test/coder" };
  assert.throws(() => service.create({ ...base, team: "" }), /Team is invalid/);
  assert.throws(() => service.create({ ...base, team: "A".repeat(33) }), /Team is invalid/);
  assert.throws(() => service.create({ ...base, team: 42 }), /Team is invalid/);
});

test("rejects invalid URL and unsupported Agent", () => {
  const profiles = { getAll: () => [], getById: () => undefined, create: () => {}, update: () => {}, delete: () => true };
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => {} }, gateway: { testConnection: async () => ({ status: "CONNECTED" }) } });
  assert.throws(() => service.save({ agent_id: "runtime", role: "coder", gateway_url: "https://gateway.example.test/runtime", enabled: true }), /UUID/);
  assert.throws(() => service.save({ agent_id: "66666666-6666-4666-8666-666666666666", role: "coder", gateway_url: "http://insecure", enabled: true }), /HTTPS/);
});

test("lists four masked profiles without exposing a submitted API key", () => {
  let profile;
  const profiles = { getAll: () => profile ? [profile] : [], getById: (id) => profile?.agent_id === id ? profile : undefined, create: (value) => (profile = structuredClone(value)), update: (value) => (profile = structuredClone(value)), delete: () => true };
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => {} }, gateway: { testConnection: async () => ({ status: "CONNECTED" }) } });
  const input = { agent_id: "77777777-7777-4777-8777-777777777777", role: "reviewer", gateway_url: "https://gateway.example.test/reviewer", enabled: true, api_key: "not-for-a-profile" };
  service.save(input);
  assert.equal(input.api_key, "not-for-a-profile");
  const settings = service.list();
  assert.equal(settings.length, 1);
  assert.equal(settings.find((item) => item.agent_id === "77777777-7777-4777-8777-777777777777").api_key, undefined);
  assert.equal(JSON.stringify(settings).includes("not-for-a-profile"), false);
});

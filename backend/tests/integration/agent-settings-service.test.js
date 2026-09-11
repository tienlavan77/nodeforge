import assert from "node:assert/strict";
import test from "node:test";
import { createAgentSettingsService } from "../../src/application/agent-settings-service.js";

test("saves masked Agent Settings through Profile/Configuration and tests connection via Gateway", async () => {
  let profile;
  const profiles = { getAll: () => profile ? [profile] : [], getById: (id) => id === profile?.agent_id ? profile : undefined, create: (value) => (profile = structuredClone(value)), update: (value) => (profile = structuredClone(value)), delete: () => true };
  let synced = 0; let tested = 0;
  const service = createAgentSettingsService({ profiles, configuration: { sync: () => { synced += 1; } }, gateway: { testConnection: async () => { tested += 1; return { status: "CONNECTED", gateway_url: profile.gateway_url }; } } });
  const saved = service.save({ agent_id: "55555555-5555-4555-8555-555555555555", agent_name: "Builder", role: "coder", gateway_url: "https://gateway.example.test/builder", enabled: true, api_key: "secret" });
  assert.equal(saved.api_key_masked, "********"); assert.equal(profile.api_key, undefined); assert.equal(synced, 1);
  assert.equal((await service.testConnection("55555555-5555-4555-8555-555555555555")).status, "CONNECTED"); assert.equal(tested, 1);
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

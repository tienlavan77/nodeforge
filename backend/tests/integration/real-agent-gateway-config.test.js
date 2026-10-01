// Verifies Claude and Anthropic profiles share the Claude SDK connection path with distinct identities.
import assert from "node:assert/strict";
import test from "node:test";

import { createAgentSettingsService } from "../../src/application/agent-settings-service.js";

// Builds a disposable profile store to check SDK routing without depending on a live API.
test("Claude and Anthropic profiles use the shared Claude SDK with their own credential references", async () => {
  const rows = new Map();
  const calls = [];
  const secrets = new Map();
  const profiles = {
    create(profile) { rows.set(profile.agent_id, profile); return profile; },
    update(profile) { rows.set(profile.agent_id, profile); return profile; },
    delete(id) { const row = rows.get(id); rows.delete(id); return row; },
    getAll() { return [...rows.values()]; },
    getById(id) { return rows.get(id); }
  };
  const settings = createAgentSettingsService({
    profiles, configuration: { sync() {} },
    gateway: { testConnection() { throw new Error("Generic gateway must not handle Claude profiles."); } },
    claudeSdkGateway: { async execute(input) { calls.push(input); return { text: "OK" }; } },
    secretStore: secrets
  });
  const agents = [
    { agent_id: "a1111111-1111-4111-8111-111111111111", provider: "claude", role: "architecture_manager" },
    { agent_id: "a2222222-2222-4222-8222-222222222222", provider: "anthropic", role: "reviewer" }
  ];
  for (const agent of agents) {
    const saved = settings.create({ ...agent, agent_name: agent.provider, model: "claude-sonnet-4-5", gateway_url: "https://gateway.example.test", enabled: true, status: "ready", api_key: `secret-${agent.provider}` });
    assert.equal(saved.credential_ref, `runtime:${agent.agent_id}:api-key`);
    assert.equal(saved.api_key_masked, "********");
    assert.equal(JSON.stringify(saved).includes(`secret-${agent.provider}`), false);
    assert.equal((await settings.testConnection(agent.agent_id)).status, "CONNECTED");
  }
  assert.deepEqual(calls.map(({ agentId }) => agentId), agents.map(({ agent_id }) => agent_id));
  assert.equal(secrets.get(`runtime:${agents[0].agent_id}:api-key`), "secret-claude");
  assert.equal(secrets.get(`runtime:${agents[1].agent_id}:api-key`), "secret-anthropic");
});

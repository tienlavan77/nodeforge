// Verifies bootstrap credentials cannot replace the API keys selected by agent profiles.
import assert from "node:assert/strict";
import test from "node:test";
import { syncArchitectureProfile } from "../../scripts/control-api-agent.mjs";

// Builds a small profile store to inspect startup credential migration without secrets in output.
function profilesFor(profile) {
  const values = [profile];
  return { getAll: () => values.map((value) => ({ ...value })), update: (value) => { values[0] = value; } };
}

test("migrates the legacy shared architecture reference to a profile reference", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "openai", gateway_url: "https://gateway.test/v1", credential_ref: "env:OPENAI_API_KEY", enabled: true, status: "ready" });
  const secrets = new Map([["env:OPENAI_API_KEY", "profile-secret"]]);
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  const current = profiles.getAll()[0];
  assert.equal(current.credential_ref, "runtime:architect:api-key");
  assert.equal(current.gateway_url, "https://gateway.test/v1");
  assert.equal(secrets.get(current.credential_ref), "profile-secret");
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "changed-secret", env: {} });
  assert.equal(secrets.get(current.credential_ref), "profile-secret");
});

test("bootstrap keeps an existing profile credential and a configured gateway", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "codex", gateway_url: "https://gateway.test/v1", credential_ref: "runtime:architect:api-key", enabled: true, status: "ready" });
  const secrets = new Map([["runtime:architect:api-key", "profile-secret"]]);
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  assert.equal(profiles.getAll()[0].credential_ref, "runtime:architect:api-key");
  assert.equal(profiles.getAll()[0].gateway_url, "https://gateway.test/v1");
  assert.equal(secrets.get("runtime:architect:api-key"), "profile-secret");
});

test("placeholder gateway seeds only its own architecture credential", () => {
  const profiles = profilesFor({ agent_id: "architect", role: "architecture_manager", provider: "openai", gateway_url: "https://gateway.example.test/agent", credential_ref: "runtime:architect:api-key", enabled: false, status: "not_connected" });
  const secrets = new Map();
  syncArchitectureProfile({ profiles, secrets, codexBaseUrl: "https://bootstrap.test/v1", bootstrapCredential: "bootstrap-secret", env: {} });
  assert.equal(profiles.getAll()[0].credential_ref, "runtime:architect:api-key");
  assert.equal(secrets.get("runtime:architect:api-key"), "bootstrap-secret");
  assert.equal(secrets.has("env:OPENAI_API_KEY"), false);
});

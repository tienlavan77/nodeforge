import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";

test("creates, updates, queries, and reloads immutable Agent Profiles without plaintext secrets", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-profile-144-"));
  let database = await openIndexDatabase(root);
  try {
    const store = createAgentProfileStore({ database });
    const first = store.create(profile("architecture-manager", "env:ARCHITECTURE_MANAGER_API_KEY"));
    store.create(profile("builder", "env:BUILDER_API_KEY"));
    assert.equal(first.agent_id, "architecture-manager");
    assert.equal(store.getAll().length, 2);
    assert.throws(() => store.create(profile("builder", "env:BUILDER_API_KEY")), /already exists/);
    const changed = store.update({ ...first, gateway_url: "https://gateway.example.test/architecture-v2", updated_at: "2026-08-22T11:00:00Z" });
    assert.equal(changed.gateway_url.endsWith("v2"), true);
    changed.agent_name = "mutated";
    assert.equal(store.getById("architecture-manager").agent_name, "Architecture Manager");
    assert.throws(() => store.create({ ...profile("reviewer", "env:REVIEWER_API_KEY"), api_key: "secret" }), /plaintext credentials/);
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createAgentProfileStore({ database });
    assert.deepEqual(restarted.getAll().map(({ agent_id }) => agent_id), ["architecture-manager", "builder"]);
    assert.equal(restarted.getById("architecture-manager").gateway_url.endsWith("v2"), true);
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid profiles and unknown updates", () => {
  const store = createAgentProfileStore();
  assert.throws(() => store.create(profile("runtime", "env:RUNTIME_KEY")), /Invalid Agent Profile/);
  assert.throws(() => store.create({ ...profile("reviewer", "env:REVIEWER_KEY"), gateway_url: "http://insecure.test" }), /Invalid Agent Profile/);
  assert.throws(() => store.update(profile("reviewer", "env:REVIEWER_KEY")), /Unknown Agent Profile/);
});

function profile(agentId, credentialRef) {
  const names = { "architecture-manager": "Architecture Manager", builder: "Builder", reviewer: "Reviewer" };
  return { agent_id: agentId, agent_name: names[agentId] ?? agentId, gateway_url: "https://gateway.example.test/agent", credential_ref: credentialRef, enabled: true, created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" };
}

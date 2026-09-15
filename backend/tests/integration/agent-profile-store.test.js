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
    const first = store.create({ ...profile("11111111-1111-4111-8111-111111111111", "architecture_manager", "env:ARCHITECTURE_MANAGER_API_KEY"), team: "platform" });
    store.create(profile("22222222-2222-4222-8222-222222222222", "coder", "env:BUILDER_API_KEY"));
    assert.equal(first.agent_id, "11111111-1111-4111-8111-111111111111");
    assert.equal(store.getAll().length, 2);
    assert.throws(() => store.create(profile("22222222-2222-4222-8222-222222222222", "coder", "env:BUILDER_API_KEY")), /already exists/);
    const changed = store.update({ ...first, gateway_url: "https://gateway.example.test/architecture-v2", updated_at: "2026-08-22T11:00:00Z" });
    assert.equal(changed.gateway_url.endsWith("v2"), true);
    changed.agent_name = "mutated";
    assert.equal(store.getById("11111111-1111-4111-8111-111111111111").agent_name, "Architecture Manager");
    assert.throws(() => store.create({ ...profile("33333333-3333-4333-8333-333333333333", "reviewer", "env:REVIEWER_API_KEY"), api_key: "secret" }), /plaintext credentials/);
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createAgentProfileStore({ database });
    assert.deepEqual(restarted.getAll().map(({ agent_id }) => agent_id), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
    assert.equal(restarted.getById("11111111-1111-4111-8111-111111111111").gateway_url.endsWith("v2"), true);
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid profiles and unknown updates", () => {
  const store = createAgentProfileStore();
  assert.throws(() => store.create(profile("runtime", "coder", "env:RUNTIME_KEY")), /Invalid Agent Profile/);
  assert.throws(() => store.create({ ...profile("33333333-3333-4333-8333-333333333333", "reviewer", "env:REVIEWER_KEY"), gateway_url: "http://insecure.test" }), /Invalid Agent Profile/);
  assert.throws(() => store.update(profile("33333333-3333-4333-8333-333333333333", "reviewer", "env:REVIEWER_KEY")), /Unknown Agent Profile/);
});

function profile(agentId, role, credentialRef) {
  const names = { architecture_manager: "Architecture Manager", coder: "Builder", reviewer: "Reviewer" };
  return { agent_id: agentId, agent_name: names[role] ?? agentId, role, gateway_url: "https://gateway.example.test/agent", credential_ref: credentialRef, enabled: true, status: "ready", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" };
}

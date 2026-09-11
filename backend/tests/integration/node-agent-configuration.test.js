import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeAgentConfiguration } from "../../src/modules/agent/node-agent-configuration.js";

test("syncs all four Agent Profile configurations to a protected reloadable Node projection", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-config-145-"));
  try {
    const ids = {
      architecture_manager: "11111111-1111-4111-8111-111111111111",
      sprint_leader: "22222222-2222-4222-8222-222222222222",
      coder: "33333333-3333-4333-8333-333333333333",
      reviewer: "44444444-4444-4444-8444-444444444444"
    };
    const source = new Map(Object.entries(ids).map(([role, agentId]) => [agentId, profile(agentId, role)]));
    const profiles = { getAll: () => [...source.values()].map((value) => structuredClone(value)), getById: (id) => structuredClone(source.get(id)) };
    const path = join(root, "runtime", "agent-config.json");
    const first = createNodeAgentConfiguration({ profiles, configurationPath: path });
    assert.deepEqual(first.sync().map(({ agent_id }) => agent_id), ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"]);
    const text = await readFile(path, "utf8");
    assert(!text.includes("real-api-key"));
    source.set("33333333-3333-4333-8333-333333333333", { ...profile("33333333-3333-4333-8333-333333333333", "coder"), enabled: false, status: "not_connected", updated_at: "2026-08-22T11:00:00Z" });
    first.sync();
    const restarted = createNodeAgentConfiguration({ profiles, configurationPath: path });
    assert.equal(restarted.getById("33333333-3333-4333-8333-333333333333").enabled, false);
    const read = restarted.getById("33333333-3333-4333-8333-333333333333"); read.gateway_url = "mutated";
    assert.notEqual(restarted.getById("33333333-3333-4333-8333-333333333333").gateway_url, "mutated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid projections and plaintext credential fields", () => {
  const profiles = { getAll: () => [{ ...profile("33333333-3333-4333-8333-333333333333", "coder"), api_key: "real-api-key" }], getById: () => undefined };
  assert.throws(() => createNodeAgentConfiguration({ profiles, configurationPath: "/tmp/nodeforge-invalid-agent-config.json" }).sync(), /plaintext credentials/);
  assert.throws(() => createNodeAgentConfiguration({ profiles, configurationPath: "" }), /configuration path/);
});

function profile(agentId, role) { return { agent_id: agentId, agent_name: role, role, gateway_url: `https://gateway.example.test/${role}`, credential_ref: `env:${role.toUpperCase()}_API_KEY`, enabled: true, status: "ready", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" }; }

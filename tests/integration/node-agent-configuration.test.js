import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createNodeAgentConfiguration } from "../../src/modules/agent/node-agent-configuration.js";

test("syncs all four Agent Profile configurations to a protected reloadable Node projection", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-agent-config-145-"));
  try {
    const source = new Map(["architecture-manager", "sprint-leader", "builder", "reviewer"].map((agentId) => [agentId, profile(agentId)]));
    const profiles = { getAll: () => [...source.values()].map((value) => structuredClone(value)), getById: (id) => structuredClone(source.get(id)) };
    const path = join(root, "runtime", "agent-config.json");
    const first = createNodeAgentConfiguration({ profiles, configurationPath: path });
    assert.deepEqual(first.sync().map(({ agent_id }) => agent_id), ["architecture-manager", "builder", "reviewer", "sprint-leader"]);
    const text = await readFile(path, "utf8");
    assert(!text.includes("real-api-key"));
    source.set("builder", { ...profile("builder"), enabled: false, status: "disabled", updated_at: "2026-08-22T11:00:00Z" });
    first.sync();
    const restarted = createNodeAgentConfiguration({ profiles, configurationPath: path });
    assert.equal(restarted.getById("builder").enabled, false);
    const read = restarted.getById("builder"); read.gateway_url = "mutated";
    assert.notEqual(restarted.getById("builder").gateway_url, "mutated");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rejects invalid projections and plaintext credential fields", () => {
  const profiles = { getAll: () => [{ ...profile("builder"), api_key: "real-api-key" }], getById: () => undefined };
  assert.throws(() => createNodeAgentConfiguration({ profiles, configurationPath: "/tmp/nodeforge-invalid-agent-config.json" }).sync(), /plaintext credentials/);
  assert.throws(() => createNodeAgentConfiguration({ profiles, configurationPath: "" }), /configuration path/);
});

function profile(agentId) { return { agent_id: agentId, agent_name: agentId, gateway_url: `https://gateway.example.test/${agentId}`, credential_ref: `env:${agentId.toUpperCase().replace(/-/g, "_")}_API_KEY`, enabled: true, status: "configured", created_at: "2026-08-22T10:00:00Z", updated_at: "2026-08-22T10:00:00Z" }; }

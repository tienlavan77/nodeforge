import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRoleResolver } from "../../src/modules/agent/agent-role-resolver.js";

test("resolves a usable role to its profile UUID", () => {
  const profiles = { getAll: () => [
    profile("disabled", "coder", false, "ready"),
    profile("working", "coder", true, "working"),
    profile("ready", "coder", true, "ready")
  ] };
  const resolver = createAgentRoleResolver({ profiles });
  assert.equal(resolver.resolve("coder"), "ready");
  assert.equal(resolver.resolveProfile("coder").agent_name, "Coder nickname");
});

test("rejects unavailable and unsupported roles", () => {
  const resolver = createAgentRoleResolver({ profiles: { getAll: () => [profile("offline", "reviewer", false, "not_connected")] } });
  assert.throws(() => resolver.resolve("reviewer"), (error) => error.code === "AGENT_ROLE_NOT_AVAILABLE");
  assert.throws(() => resolver.resolve("builder"), /Unsupported Agent role/);
});

test("selects deterministically among ready profiles", () => {
  const resolver = createAgentRoleResolver({ profiles: { getAll: () => [
    profile("later", "reviewer", true, "ready", "2026-01-02T00:00:00Z"),
    profile("earlier", "reviewer", true, "ready", "2026-01-01T00:00:00Z")
  ] } });
  assert.equal(resolver.resolve("reviewer"), "earlier");
});

function profile(agent_id, role, enabled, status, created_at = "2026-01-01T00:00:00Z") {
  return { agent_id, agent_name: "Coder nickname", role, enabled, status, created_at };
}

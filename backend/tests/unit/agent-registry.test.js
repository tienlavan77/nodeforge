import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRegistry } from "../../src/modules/agent/agent-registry.js";

function agent(id, role, name = role) {
  return { id, name, role, canHandle: () => true, execute: async () => ({ status: "completed" }) };
}

test("registers, looks up, lists, and unregisters Agents deterministically", () => {
  const registry = createAgentRegistry();
  const coder = agent("AGENT-126-coder", "coder", "Coder Agent");
  const runtime = agent("AGENT-126-runtime", "runtime", "Runtime");
  registry.register(coder);
  registry.register(runtime);
  coder.name = "mutated caller";

  assert.equal(registry.has("AGENT-126-coder"), true);
  assert.equal(registry.get("AGENT-126-coder").name, "Coder Agent");
  assert.deepEqual(registry.list().map(({ id }) => id), ["AGENT-126-coder", "AGENT-126-runtime"]);
  assert.equal(registry.unregister("AGENT-126-coder"), true);
  assert.equal(registry.unregister("AGENT-126-coder"), false);
  assert.equal(registry.get("AGENT-126-coder"), undefined);
});

test("rejects duplicate, invalid, and unsupported Agents", () => {
  const registry = createAgentRegistry();
  const coder = agent("AGENT-126-coder", "coder");
  registry.register(coder);
  assert.throws(() => registry.register(coder), /already registered/);
  assert.throws(() => registry.register({ id: "AGENT-126-invalid" }), /Agent contract requires name/);
  assert.throws(() => registry.register({ ...coder, id: "AGENT-126-other", role: "owner" }), /Unsupported Agent role/);
  assert.throws(() => registry.get(""), /Agent id is required/);
  assert.throws(() => registry.has(""), /Agent id is required/);
  assert.throws(() => registry.unregister(""), /Agent id is required/);
});

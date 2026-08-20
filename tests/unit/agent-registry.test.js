import assert from "node:assert/strict";
import test from "node:test";

import { createAgentRegistry } from "../../src/modules/agent/agent-registry.js";
import { createBuilderAdapter } from "../../src/agents/builder-adapter.js";

test("registers, looks up, lists, and unregisters Agents deterministically", () => {
  const registry = createAgentRegistry();
  const builder = { ...createBuilderAdapter({ id: "AGENT-126-builder" }), role: "builder" };
  const runtime = { ...createBuilderAdapter({ id: "AGENT-126-runtime", name: "Runtime" }), role: "runtime" };
  registry.register(builder);
  registry.register(runtime);
  builder.name = "mutated caller";

  assert.equal(registry.has("AGENT-126-builder"), true);
  assert.equal(registry.get("AGENT-126-builder").name, "Builder Agent");
  assert.deepEqual(registry.list().map(({ id }) => id), ["AGENT-126-builder", "AGENT-126-runtime"]);
  assert.equal(registry.unregister("AGENT-126-builder"), true);
  assert.equal(registry.unregister("AGENT-126-builder"), false);
  assert.equal(registry.get("AGENT-126-builder"), undefined);
});

test("rejects duplicate, invalid, and unsupported Agents", () => {
  const registry = createAgentRegistry();
  const builder = { ...createBuilderAdapter({ id: "AGENT-126-builder" }), role: "builder" };
  registry.register(builder);
  assert.throws(() => registry.register(builder), /already registered/);
  assert.throws(() => registry.register({ id: "AGENT-126-invalid" }), /Agent contract requires name/);
  assert.throws(() => registry.register({ ...builder, id: "AGENT-126-other", role: "owner" }), /Unsupported Agent role/);
  assert.throws(() => registry.get(""), /Agent id is required/);
  assert.throws(() => registry.has(""), /Agent id is required/);
  assert.throws(() => registry.unregister(""), /Agent id is required/);
});

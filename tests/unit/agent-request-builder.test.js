import assert from "node:assert/strict";
import test from "node:test";
import { createAgentRequestBuilder } from "../../src/modules/agent/agent-request-builder.js";

test("enables cache for long tasks and keeps stable context identical", () => {
  const builder = createAgentRequestBuilder({ expectedSteps: 5 });
  const stable = { objective: "build", constraints: ["safe"], project_structure: "src/" };
  const first = builder.build({ taskId: "T1", stepId: 1, stableContext: stable, dynamicContext: { instruction: "one" } });
  const second = builder.build({ taskId: "T1", stepId: 2, stableContext: { ...stable }, dynamicContext: { instruction: "two" } });
  assert.equal(first.cache_enabled, true);
  assert.equal(second.cache_enabled, true);
  assert.equal(first.dynamic_context.metadata.stable_context_sha256, second.dynamic_context.metadata.stable_context_sha256);
});

test("disables cache and increments context version after stable context changes", () => {
  const builder = createAgentRequestBuilder({ expectedSteps: 5 });
  builder.build({ taskId: "T1", stepId: 1, stableContext: { objective: "old" }, dynamicContext: {} });
  const changed = builder.build({ taskId: "T1", stepId: 2, stableContext: { objective: "new" }, dynamicContext: {} });
  assert.equal(changed.cache_enabled, false);
  assert.equal(changed.dynamic_context.metadata.context_version, 1);
});

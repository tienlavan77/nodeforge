import test from "node:test";
import assert from "node:assert/strict";
import { createTestService } from "../../src/application/test-service.js";

test("TestService runs checks through the orchestrator and publishes result", async () => {
  const calls = []; const events = [];
  const service = createTestService({ projectRoot: "/tmp/project", verificationOrchestrator: { run: async (plan) => { calls.push(plan); return { status: "passed" }; } }, publisher: { publish: (event) => events.push(event) } });
  const result = await service.runLint({ commitId: "COMMIT-1" });
  assert.equal(result.status, "passed");
  assert.equal(calls[0].checks[0].type, "lint");
  assert.equal(events.at(-1).type, "verification.result");
});

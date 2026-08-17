import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentProcess } from "../../src/modules/agents/agent-process.js";
import { bindAgentCommandDispatcher, createSessionCommandDispatcher } from "../../src/modules/agents/command-idempotency.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-idempotency-fixture.js", import.meta.url));

test("caches duplicate verification.run_test request_ids within one running session", async () => {
  const executed = [];
  const agent = createAgentProcess({ command: process.execPath, args: [fixture] });
  const dispatcher = createSessionCommandDispatcher({
    async executeCommand(command) {
      executed.push(command.request_id);
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { run: executed.length, request_id: command.request_id };
    }
  });
  const binding = bindAgentCommandDispatcher({ agent, dispatcher });
  const handled = [];
  const onHandled = (outcome) => handled.push(outcome);
  binding.on("handled", onHandled);

  try {
    await waitFor(() => handled.length === 3);

    const first = handled.filter(({ envelope }) => envelope.message.request_id === "REQ-TEST-ONE");
    const second = handled.find(({ envelope }) => envelope.message.request_id === "REQ-TEST-TWO");
    assert.deepEqual(executed.sort(), ["REQ-TEST-ONE", "REQ-TEST-TWO"]);
    assert.equal(first.length, 2);
    assert.deepEqual(first.map(({ result }) => result), [first[0].result, first[0].result]);
    assert.deepEqual(first.map(({ cached }) => cached).sort(), [false, true]);
    assert.equal(second.cached, false);
    assert.equal(dispatcher.hasProcessed("SESSION-idempotency-test", "REQ-TEST-ONE"), true);
    assert.equal(dispatcher.hasProcessed("SESSION-idempotency-test", "REQ-TEST-TWO"), true);
  } finally {
    binding.close();
    agent.close();
    if (!agent.child.killed && agent.child.exitCode === null) agent.child.kill();
  }
});

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for agent commands to be handled.");
}

import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createAgentProcess } from "../../src/modules/agents/agent-process.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-timeout-fixture.js", import.meta.url));

test("terminates a timed-out Agent with agents.error followed by agents.stopped and no zombie", async () => {
  const events = [];
  const agent = createAgentProcess({
    command: process.execPath,
    args: [fixture],
    projectId: "PROJECT-timeout-test",
    agentId: "AGENT-timeout-test",
    timeoutMs: 200,
    terminateGraceMs: 50,
    createEventId: (() => {
      let sequence = 0;
      return () => `EVT-TIMEOUT-${++sequence}`;
    })(),
    clock: () => new Date("2026-08-17T14:00:00Z")
  });
  agent.on("event", (event) => events.push(event));

  const [, signal] = await once(agent.child, "exit");
  assert.equal(["SIGTERM", "SIGKILL"].includes(signal), true);
  assert.deepEqual(events.map(({ type, payload }) => ({ type, payload })), [
    { type: "agents.error", payload: { reason: "timeout" } },
    { type: "agents.stopped", payload: { reason: "timeout", exit_code: null, signal } }
  ]);
  assert.equal(events.every(({ project_id: projectId, agent_id: agentId }) => projectId === "PROJECT-timeout-test" && agentId === "AGENT-timeout-test"), true);
  await assertProcessGone(agent.child.pid);
});

async function assertProcessGone(pid) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Agent process ${pid} is still alive after timeout handling.`);
}

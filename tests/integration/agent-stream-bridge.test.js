import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBootstrap } from "../../src/bootstrap/index.js";
import { createAgentProcess } from "../../src/modules/agents/agent-process.js";

const fixture = fileURLToPath(new URL("../fixtures/agent-stream-fixture.js", import.meta.url));

test("publishes five ordered Agent stdout messages and raw stderr on the bootstrap internalBus", async () => {
  const internalBus = new EventEmitter();
  const watcher = new EventEmitter();
  const indexed = [];
  const agentStreams = [];
  const watcherEvents = [];
  const agent = createAgentProcess({ command: process.execPath, args: [fixture] });
  const bootstrap = createBootstrap({
    watcher,
    indexer: { async handle(event) { indexed.push(event); return true; } },
    agentProcesses: [agent],
    internalBus,
    logger: quietLogger()
  });
  internalBus.on("agent.stream", (message) => agentStreams.push(message));
  internalBus.on("event", (event) => watcherEvents.push(event));

  try {
    await bootstrap.start();
    watcher.emit("event", watcherEvent());
    await waitFor(() => agentStreams.length === 6 && indexed.length === 1);

    const stdout = agentStreams.filter(({ source }) => source === "agent.stdout");
    assert.deepEqual(stdout.map(({ message }) => message.message.payload.sequence), [1, 2, 3, 4, 5]);
    assert.equal(stdout.every(({ agent_id: agentId }) => agentId === "AGENT-STREAM-FIXTURE-001"), true);
    assert.deepEqual(agentStreams.find(({ source }) => source === "agent.stderr"), {
      source: "agent.stderr",
      agent_id: "AGENT-STREAM-FIXTURE-001",
      text: "fixture stream diagnostic\n"
    });
    assert.deepEqual(watcherEvents, [watcherEvent()]);
    assert.deepEqual(indexed, [watcherEvent()]);
  } finally {
    await bootstrap.stop();
    agent.close();
    if (!agent.child.killed && agent.child.exitCode === null) agent.child.kill();
  }
});

function watcherEvent() {
  return {
    event_id: "EVT-WATCHER-STREAM-001",
    type: "watcher.file_modified",
    project_id: "PROJECT-stream-test",
    timestamp: "2026-08-17T13:00:00Z",
    payload: { path: "src/example.js", operation: "change" }
  };
}

function quietLogger() {
  return { info() {}, error() {} };
}

async function waitFor(predicate, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for agent stream messages.");
}

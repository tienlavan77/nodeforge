import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";

import { createBootstrap } from "../../src/bootstrap/index.js";

test("bootstrap loads config and starts and stops cleanly", async () => {
  const logs = [];
  const bootstrap = createBootstrap({
    configOptions: { cwd: "/workspace", overrides: { dataDir: ".forge-test", logLevel: "info" } },
    loggerOptions: { sink: { log: (entry) => logs.push(entry) } }
  });

  await bootstrap.start();

  assert.equal(bootstrap.state, "running");
  assert.equal(bootstrap.config.dataDir, "/workspace/.forge-test");
  assert.equal(logs[0].severity, "info");

  await bootstrap.stop();

  assert.equal(bootstrap.state, "stopped");
  assert.equal(logs[1].message, "Nodeforge bootstrap stopped");
});

// Exercises the moved bridge through the production bootstrap consumer, including restart cleanup
// and stderr redaction so source organization cannot silently detach or expose agent streams.
test("bootstrap forwards agent streams with redaction and removes listeners on stop", async () => {
  const agent = new EventEmitter();
  const internalBus = new EventEmitter();
  const received = [];
  internalBus.on("agent.stream", (event) => received.push(event));
  const bootstrap = createBootstrap({
    agentProcesses: [agent], internalBus,
    configOptions: { cwd: "/workspace", overrides: { dataDir: ".forge-test", logLevel: "info" } },
    loggerOptions: { sink: { log() {} } }
  });
  await bootstrap.start();
  const envelope = { sender: { id: "AGENT-BRIDGE" }, message: { type: "output" } };
  agent.emit("message", envelope);
  agent.emit("stderr", "Authorization: Bearer bridge-secret");
  assert.equal(received.length, 2);
  assert.equal(received[0].message, envelope);
  assert.equal(received[0].agent_id, "AGENT-BRIDGE");
  assert.equal(received[1].source, "agent.stderr");
  assert.ok(!received[1].text.includes("bridge-secret"));
  await bootstrap.stop();
  assert.equal(agent.listenerCount("message"), 0);
  assert.equal(agent.listenerCount("stderr"), 0);
  agent.emit("message", envelope);
  assert.equal(received.length, 2);
  await bootstrap.start();
  assert.equal(agent.listenerCount("message"), 1);
  await bootstrap.stop();
  assert.equal(agent.listenerCount("message"), 0);
});

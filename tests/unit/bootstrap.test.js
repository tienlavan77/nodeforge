import assert from "node:assert/strict";
import test from "node:test";

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

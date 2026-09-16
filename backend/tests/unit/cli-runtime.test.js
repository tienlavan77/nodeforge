import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { runCli } from "../../src/transport/cli/index.js";

test("rejects removed Agent CLI commands", async () => {
  const output = [];
  const stderr = { write(value) { output.push(value); } };

  assert.equal(await runCli(["run", "PROJECT-107", "TASK-107"], { stderr, signalEmitter: new EventEmitter() }), 1);
  assert.deepEqual(output, ["Usage: forge index rebuild | forge watch [path]\n"]);
});

import assert from "node:assert/strict";
import test from "node:test";

import { createProjectCommandExecutor } from "../../src/modules/verification/command-executor.js";

test("terminates a verification command at timeout", async () => {
  const execute = createProjectCommandExecutor({ projectRoot: process.cwd() });
  const result = await execute(`${JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 200)"`, { timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

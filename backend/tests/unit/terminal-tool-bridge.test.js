import test from "node:test";
import assert from "node:assert/strict";
import { createReviewerTerminalToolBridge, createTerminalToolBridge } from "../../src/modules/agent/terminal-tool-bridge.js";

test("terminal bridge denies commands without explicit approval", async () => {
  const bridge = createTerminalToolBridge({ projectRoot: process.cwd() });
  await assert.rejects(() => bridge.run({ command: "npm test" }), /requires owner approval/);
});

test("terminal bridge rejects non-allowlisted and shell-composed commands", async () => {
  const bridge = createTerminalToolBridge({ projectRoot: process.cwd(), approve: async () => true });
  await assert.rejects(() => bridge.run({ command: "rm -rf .", approval: true }), /not allowlisted/);
  await assert.rejects(() => bridge.run({ command: "npm test && pwd", approval: true }), /disallowed shell operators/);
});

test("reviewer bridge allows approved checks but blocks mutations", async () => {
  const bridge = createReviewerTerminalToolBridge({ projectRoot: process.cwd(), approve: async () => true });
  await assert.rejects(() => bridge.run({ command: "git commit -am review", approval: true }), /read-only/);
  const result = await bridge.run({ command: "git status --short", approval: true });
  assert.equal(typeof result.exitCode, "number");
});

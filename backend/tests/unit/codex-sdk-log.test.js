// Verifies event-driven Codex diagnostics without periodic wait noise or exposed credentials.
import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSdkLog } from "../../src/modules/agent/codex-sdk-log.js";

test("idle SDK streams stay silent while retry events redact secrets", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const lines = [];
  const log = createCodexSdkLog({ profile: { agent_id: "SE", model: "test-model" }, correlationId: "C", credential: "secret-key", output: { write: (line) => lines.push(line) } });
  log.event({ type: "thread.started" });
  log.event({ type: "turn.started" });
  const startedCount = lines.length;
  t.mock.timers.tick(300000);
  assert.equal(lines.length, startedCount);
  log.event({ type: "error", message: "Reconnecting 2/5 secret-key https://gateway.test/private" });
  assert.match(lines.join(""), /sdk.transport Reconnecting 2\/5 \[REDACTED\] \[URL\].* - WARN/);
  log.event({ type: "item.completed", item: { type: "agent_message", text: "private source text" } });
  log.close();
  const count = lines.length;
  t.mock.timers.tick(60000);
  assert.equal(lines.length, count);
  assert.doesNotMatch(lines.join(""), /secret-key|gateway.test|private source text/);
  assert.doesNotMatch(lines.join(""), /WAIT no SDK events|Runner alive/);
  assert.match(lines.join(""), /sdk.completed.* - SUCCESS/);
  assert.equal(lines.length, 2, "one transport warning and one session result");
  assert.doesNotMatch(lines.join(""), /START|DONE|item\.completed/);
});

test("an open verification MCP call emits no periodic wait logs and completes normally", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const lines = [];
  const log = createCodexSdkLog({ profile: { agent_id: "Coder" }, correlationId: "C", output: { write: (line) => lines.push(line) } });
  log.event({ type: "item.started", item: { type: "mcp_tool_call", tool: "report_done" } });
  const count = lines.length;
  for (let index = 0; index < 20; index++) t.mock.timers.tick(30000);
  assert.equal(lines.length, count);
  log.event({ type: "item.completed", item: { type: "mcp_tool_call", tool: "report_done" } });
  log.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /sdk.completed.* - SUCCESS/);
  assert.doesNotMatch(lines[0], /item\.completed|START|DONE/);
});

test("logs tool boundaries and failure without logging command contents", () => {
  const lines = [];
  const log = createCodexSdkLog({ profile: { agent_name: "Cú đêm" }, correlationId: "C", output: { write: (line) => lines.push(line) } });
  try {
    log.event({ type: "item.started", item: { type: "command_execution", command: "sensitive-command" } });
    log.event({ type: "turn.failed", error: { message: "upstream unavailable" } });
  } finally { log.close(new Error("upstream unavailable")); }
  assert.equal(lines.length, 1);
  assert.match(lines.join(""), /upstream unavailable.* - FAIL/);
  assert.doesNotMatch(lines.join(""), /item\.started|START/);
  assert.doesNotMatch(lines.join(""), /sensitive-command/);
});

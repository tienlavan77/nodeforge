// Verifies owner-visible Codex wait/retry diagnostics without exposing credentials or source text.
import assert from "node:assert/strict";
import test from "node:test";
import { createCodexSdkLog } from "../../src/modules/agent/codex-sdk-log.js";

test("reports idle SDK streams and retries, redacts secrets, and clears the timer", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"] });
  const lines = [];
  const log = createCodexSdkLog({ profile: { agent_id: "SE", model: "test-model" }, correlationId: "C", credential: "secret-key", output: { write: (line) => lines.push(line) } });
  log.event({ type: "thread.started" });
  log.event({ type: "turn.started" });
  t.mock.timers.tick(30000);
  assert.match(lines.join(""), /WAIT no SDK events for 30s; last=turn.started/);
  log.event({ type: "error", message: "Reconnecting 2/5 secret-key https://gateway.test/private" });
  assert.match(lines.join(""), /RETRY\/ERROR Reconnecting 2\/5 \[REDACTED\] \[URL\]/);
  log.event({ type: "item.completed", item: { type: "agent_message", text: "private source text" } });
  log.close();
  const count = lines.length;
  t.mock.timers.tick(60000);
  assert.equal(lines.length, count);
  assert.doesNotMatch(lines.join(""), /secret-key|gateway.test|private source text/);
  assert.match(lines.join(""), /DONE/);
});

test("logs tool boundaries and failure without logging command contents", () => {
  const lines = [];
  const log = createCodexSdkLog({ profile: { agent_name: "Cú đêm" }, correlationId: "C", output: { write: (line) => lines.push(line) } });
  try {
    log.event({ type: "item.started", item: { type: "command_execution", command: "sensitive-command" } });
    log.event({ type: "turn.failed", error: { message: "upstream unavailable" } });
  } finally { log.close(new Error("upstream unavailable")); }
  assert.match(lines.join(""), /item.started:command_execution/);
  assert.match(lines.join(""), /FAIL upstream unavailable/);
  assert.doesNotMatch(lines.join(""), /sensitive-command/);
});

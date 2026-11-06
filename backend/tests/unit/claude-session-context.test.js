// Business purpose: prevents undercounted Claude cache usage from bypassing preflight compaction.
// Technical description: exercises exact-session transcript recovery, latest-call selection,
// missing files, malformed trailing records, and conversation isolation with temporary homes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClaudeSessionContext } from "../../src/modules/agent/claude-session-context.js";

// Business purpose: verifies that preflight recovers cached tokens from the selected conversation.
// Technical description: writes different sessions and incomplete JSON, then checks exact latest-call occupancy.
test("Claude context probe includes cache tokens and isolates exact sessions", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-claude-context-"));
  try {
    const project = join(home, "projects", "project");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "SESSION.jsonl"), [
      JSON.stringify({ type: "assistant", timestamp: "2026-11-06T06:37:00Z", message: { usage: { input_tokens: 8, cache_creation_input_tokens: 7230, cache_read_input_tokens: 472448 } } }),
      JSON.stringify({ type: "assistant", timestamp: "2026-11-06T06:39:00Z", message: { usage: { input_tokens: 379, cache_creation_input_tokens: 0, cache_read_input_tokens: 492032 } } }),
      '{"partial":'
    ].join("\n"));
    writeFileSync(join(project, "OTHER.jsonl"), JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 999999 } } }));
    assert.equal(readClaudeSessionContext(home, "SESSION"), 492411);
    assert.equal(readClaudeSessionContext(home, "MISSING"), null);
    assert.equal(readClaudeSessionContext(home, "../OTHER"), null);
    assert.equal(readClaudeSessionContext(join(home, "different-conversation"), "SESSION"), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

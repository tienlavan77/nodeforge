// Verifies log scrolling redraws only the viewport content while the command and status positions remain fixed.
import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundView } from "../../scripts/dev-foreground-view.mjs";

test("log scroll preserves fixed status and input rows", () => {
  const chunks = [];
  const output = { rows: 24, columns: 80, write: (chunk) => chunks.push(chunk) };
  const logLines = Array.from({ length: 30 }, (_, index) => ({ name: "SYSTEM", line: `log-${index}` }));
  const { render } = createForegroundView({ children: new Map(), serviceState: new Map(), logLines, suggestions: ["/q quit", "/r api restart"], isActive: () => true, output, getGitInfo: () => "main", getEmbeddingProgress: () => "" });
  const state = { input: "command", cursor: 7, scrollBack: 0, copyMode: false };
  render(state);
  const latest = chunks.join("");
  chunks.length = 0;
  state.scrollBack = 6;
  render(state);
  const older = chunks.join("");
  for (const screen of [latest, older]) {
    assert.ok(screen.includes("\x1b[20;1H"), "status row stays fixed");
    assert.ok(screen.includes("\x1b[22;1H"), "input border stays fixed");
    assert.ok(screen.includes("\x1b[23;1H"), "command input stays fixed");
    assert.ok(screen.includes("\x1b[24;1H"), "bottom border stays fixed");
  }
  assert.ok(latest.includes("log-29"));
  assert.ok(!older.includes("log-29"));
  assert.ok(older.includes("log-5"));
  chunks.length = 0;
  state.input = "/";
  state.cursor = 1;
  render(state);
  const withSuggestions = chunks.join("");
  assert.ok(withSuggestions.includes("\x1b[20;1H"), "suggestions do not move status");
  assert.ok(withSuggestions.includes("\x1b[22;1H"), "suggestions do not move input");
  chunks.length = 0;
  state.copyMode = true;
  render(state);
  assert.deepEqual(chunks, []);
});

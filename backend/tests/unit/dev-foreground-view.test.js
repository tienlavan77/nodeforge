// Verifies log scrolling redraws only the viewport content while the command and status positions remain fixed.
import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundView } from "../../scripts/dev-foreground-view.mjs";
import { definitions, suggestions, FOREGROUND_STARTUP_MESSAGE, FOREGROUND_HELP_MESSAGE, executeForegroundCommand } from "../../scripts/dev-foreground.mjs";

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

test("dev:foreground supervises only api and ui, accepts /r api and /r ui, and rejects /r watcher", async () => {
  assert.deepEqual(Object.keys(definitions), ["api", "ui"]);
  assert.equal(FOREGROUND_STARTUP_MESSAGE, "Services starting: api, ui");
  assert.deepEqual(suggestions, ["/q quit", "/r api restart", "/r ui restart", "/copy", "/save log.txt"]);
  assert.ok(!suggestions.some((item) => item.includes("watcher")));

  const chunks = [];
  const output = { rows: 24, columns: 100, write: (chunk) => chunks.push(chunk) };
  const { render } = createForegroundView({
    children: new Map(),
    serviceState: new Map([["api", "running"], ["ui", "running"]]),
    logLines: [],
    suggestions,
    isActive: () => true,
    output,
    getGitInfo: () => "main",
    getEmbeddingProgress: () => "embed ████░░░░░░░░ 33% · 1/3 done · 2 queued · 1 vectors"
  });
  render({ input: "", cursor: 0, scrollBack: 0, copyMode: false });
  const emptyPromptScreen = chunks.join("");
  assert.ok(emptyPromptScreen.includes("/r api|ui restart"));
  assert.ok(!emptyPromptScreen.includes("watcher"));
  assert.ok(emptyPromptScreen.includes("embed ████░░░░░░░░ 33%"));

  const restarted = [];
  const saved = [];
  const helpMessages = [];
  let quitted = 0;
  let copied = 0;
  const handlers = {
    onShutdown: () => { quitted += 1; },
    onRestart: (service) => { restarted.push(service); },
    onCopy: () => { copied += 1; },
    onSave: (target) => { saved.push(target); },
    onHelp: (msg) => { helpMessages.push(msg); }
  };

  assert.deepEqual(await executeForegroundCommand("/r api", handlers), { action: "restart", service: "api" });
  assert.deepEqual(await executeForegroundCommand("/r ui", handlers), { action: "restart", service: "ui" });
  assert.deepEqual(await executeForegroundCommand("/r watcher", handlers), { action: "help", message: FOREGROUND_HELP_MESSAGE });
  assert.deepEqual(await executeForegroundCommand("/copy", handlers), { action: "copy" });
  assert.deepEqual(await executeForegroundCommand("/save custom.log", handlers), { action: "save", path: "custom.log" });
  assert.deepEqual(await executeForegroundCommand("/q", handlers), { action: "quit" });

  assert.deepEqual(restarted, ["api", "ui"]);
  assert.deepEqual(saved, ["custom.log"]);
  assert.equal(copied, 1);
  assert.equal(quitted, 1);
  assert.deepEqual(helpMessages, ["Commands: /q quit · /r api|ui restart · /copy select · /save <file>"]);
});

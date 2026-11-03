// Verifies log scrolling redraws only the viewport content while the command and status positions remain fixed.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createForegroundView } from "../../scripts/dev-foreground-view.mjs";
import { definitions, suggestions, FOREGROUND_STARTUP_MESSAGE, FOREGROUND_HELP_MESSAGE, executeForegroundCommand, createForegroundController } from "../../scripts/dev-foreground.mjs";

// Business purpose: verifies that log viewport scrolling keeps the status bar and command input box at fixed terminal rows.
// Technical description: renders latest, scrolled-back, suggestion-expanded, and copy-mode states and asserts ANSI cursor positioning and viewport lines.
function verifyForegroundScrollLayout() {
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
}

// Business purpose: verifies that dev:foreground supervises only api and ui, renders embedding progress, and rejects /r watcher.
// Technical description: asserts service definitions, startup/help messages, prompt placeholder rendering, and executeForegroundCommand routing for /r api, /r ui, /r watcher, /copy, /save, and /q.
async function verifyForegroundServicesAndCommands() {
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
}

test("log scroll preserves fixed status and input rows", verifyForegroundScrollLayout);
test("dev:foreground supervises only api and ui, accepts /r api and /r ui, and rejects /r watcher", verifyForegroundServicesAndCommands);

// Polls an asynchronous assertion condition until it becomes truthy or times out.
async function waitForCondition(predicate, timeoutMs = 6000, getDebug = () => "") {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`Timed out waiting for foreground controller condition: ${getDebug()}`);
}

// Business purpose: verifies real supervised API child process startup, worker-log-driven embedding progress rendering, /r api process restart, and SIGTERM cleanup.
// Technical description: spawns a real Node API subprocess running startControlApiWorkers and startControlApi over SQLite, triggers file indexing and vector completion logs, renders createForegroundView without stubs, executes /r api to replace the running PID, and shuts down via /q.
async function verifyForegroundApiRestartAndWorkerLogProgress(context) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-foreground-api-"));
  context.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "src"), { recursive: true });
  const repoRoot = resolve(process.cwd());
  const apiScriptPath = join(projectRoot, "run-api-fixture.mjs");
  await writeFile(apiScriptPath, [
    `import { createServer } from "node:http";`,
    `import { EventEmitter } from "node:events";`,
    `import { join } from "node:path";`,
    `import { writeFile } from "node:fs/promises";`,
    `import { createDatabaseService } from ${JSON.stringify(join(repoRoot, "backend/src/infrastructure/sqlite/database-service.js"))};`,
    `import { createRuntimeLogger } from ${JSON.stringify(join(repoRoot, "backend/src/core/runtime-logger.js"))};`,
    `import { startControlApiWorkers } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-project-runtime.mjs"))};`,
    `import { startControlApi } from ${JSON.stringify(join(repoRoot, "backend/scripts/control-api-lifecycle.mjs"))};`,
    `const projectRoot = ${JSON.stringify(projectRoot)};`,
    `const indexDb = await createDatabaseService({ dataDir: projectRoot, runtimeDir: join(".forge", "runtime", "wc") });`,
    `const runtimeLogger = createRuntimeLogger({ logEvent: () => {}, output: process.stdout, source: "project-watcher" });`,
    `const rawWatcher = new EventEmitter();`,
    `rawWatcher.close = async () => {};`,
    `const workers = startControlApiWorkers({`,
    `  projectRoot,`,
    `  projectId: "PROJECT-FG",`,
    `  indexDb,`,
    `  runtimeLogger,`,
    `  watcherFactory: () => rawWatcher,`,
    `  debounceMs: 100,`,
    `  renameWindowMs: 100,`,
    `  pollMs: 30,`,
    `  runVerification: false,`,
    `  ollamaConfig: { host: "http://127.0.0.1:11434", model: "fg-embed-model", timeoutMs: 1000 },`,
    `  embeddingProvider: { async embed() { return [0.5, 0.25, 0.75]; }, async close() {} }`,
    `});`,
    `startControlApi({`,
    `  api: { createServer },`,
    `  port: 0,`,
    `  host: "127.0.0.1",`,
    `  workers: [workers],`,
    `  indexDb,`,
    `  controlDb: { close: async () => {} },`,
    `  processLock: { release: () => { console.log("API_LOCK_RELEASED"); } }`,
    `});`,
    `const target = join(projectRoot, "src", "fg-item-" + process.pid + ".js");`,
    `const sourceText = ${JSON.stringify("// Foreground watched module.\n\n// Computes item subtotal for foreground worker test.\nexport function computeSubtotal(price) { return price * 2; }\n")};`,
    `await writeFile(target, sourceText);`,
    `rawWatcher.emit("add", target);`
  ].join("\n"));

  const chunks = [];
  const output = { rows: 24, columns: 110, write: (chunk) => chunks.push(String(chunk)) };
  const controller = createForegroundController({
    serviceDefinitions: {
      api: { command: process.execPath, args: [apiScriptPath], cwd: projectRoot }
    },
    output,
    projectRoot,
    getGitInfo: () => "main"
  });
  context.after(() => controller.shutdown());

  const firstChild = controller.start("api");
  const firstPid = firstChild.pid;
  assert.ok(Number.isInteger(firstPid) && firstPid > 0);

  await waitForCondition(() => controller.logLines.some((entry) => entry.line.includes("Embedding job completed (1 done, 0 queued, 1 vectors).")), 4000, () => JSON.stringify(controller.logLines));
  chunks.length = 0;
  controller.render({ input: "", cursor: 0, scrollBack: 0, copyMode: false });
  const liveScreen = chunks.join("");
  assert.ok(liveScreen.includes("embed "), "renders live embedding progress bar from API worker logs and SQLite");
  assert.ok(liveScreen.includes("100% · 1/1 done · 0 queued · 1 vectors"), "displays completed embedding job and vector counts");

  const restartResult = await controller.executeCommand("/r api");
  assert.deepEqual(restartResult, { action: "restart", service: "api" });
  const secondChild = controller.children.get("api");
  assert.ok(secondChild && secondChild.pid !== firstPid, "spawns a new API child process on /r api");
  assert.notEqual(firstChild.exitCode ?? firstChild.signalCode, null, "terminates previous API child process on /r api");
  assert.ok(controller.logLines.some((entry) => entry.line.includes("api: restarting...")));
  assert.ok(controller.logLines.some((entry) => entry.name === "api" && entry.line === "stopped"));
  assert.ok(controller.logLines.some((entry) => entry.line.includes(`api: restarted successfully (pid ${secondChild.pid})`)));

  await waitForCondition(() => controller.logLines.filter((entry) => entry.line.includes("Project filesystem watcher ready (polling).")).length >= 2);
  const quitResult = await controller.executeCommand("/q");
  assert.deepEqual(quitResult, { action: "quit" });
  assert.equal(controller.children.size, 0);
}

test("dev:foreground supervises real API child startup, renders worker-log-driven embedding progress, and restarts API via /r api", verifyForegroundApiRestartAndWorkerLogProgress);

// Summary: Runs the API (with in-process Watcher and Embedding Workers) and web development services under one interactive controller.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createMouseSelection } from "./dev-foreground-selection.mjs";
import { createKeyParser } from "./dev-foreground-keys.mjs";
import { createForegroundView } from "./dev-foreground-view.mjs";
import { alive, findMatchingPids } from "./dev-foreground-process.mjs";
import { createForegroundLogReceiver, formatForegroundLine } from "./dev-foreground-line.mjs";

// Business purpose: provides the supervised service definitions, autocomplete suggestions, and status messages for the foreground development controller.
// Technical description: defines only the api and ui child process commands (since Watcher and Embedding Workers run in-process inside Control API) and exports the corresponding CLI help and startup strings.
export function getForegroundServiceDefinitions() {
  return {
    definitions: {
      api: { command: process.execPath, args: ["backend/scripts/start-control-api.mjs"] },
      ui: { command: "pnpm", args: ["--dir", "ui/nextjs", "dev"] }
    },
    suggestions: ["/q quit", "/r api restart", "/r ui restart", "/copy", "/save log.txt"],
    startupMessage: "Services starting: api, ui",
    helpMessage: "Commands: /q quit · /r api|ui restart · /copy select · /save <file>"
  };
}
export const {
  definitions,
  suggestions,
  startupMessage: FOREGROUND_STARTUP_MESSAGE,
  helpMessage: FOREGROUND_HELP_MESSAGE
} = getForegroundServiceDefinitions();
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ansiPattern = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const oscPattern = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const children = new Map();
const serviceState = new Map(Object.keys(definitions).map((name) => [name, "starting"]));
const logLines = [];
let shuttingDown = false;

// Parses and dispatches an interactive foreground command to the corresponding controller action.
export async function executeForegroundCommand(rawInput, { onShutdown, onRestart, onCopy, onSave, onHelp } = {}) {
  const value = String(rawInput ?? "").trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  if (lower === "/q" || lower === "/quit" || lower === "exit") {
    await onShutdown?.();
    return { action: "quit" };
  }
  const restart = lower.match(/^\/r\s+(api|ui)$/);
  if (restart) {
    await onRestart?.(restart[1]);
    return { action: "restart", service: restart[1] };
  }
  if (lower === "/copy") {
    onCopy?.();
    return { action: "copy" };
  }
  if (lower.startsWith("/save")) {
    const targetPath = value.slice(5).trim() || "dev-foreground.log";
    onSave?.(targetPath);
    return { action: "save", path: targetPath };
  }
  onHelp?.(FOREGROUND_HELP_MESSAGE);
  return { action: "help", message: FOREGROUND_HELP_MESSAGE };
}

// Business purpose: creates a programmable foreground process supervisor for starting, restarting, and stopping api and ui services while streaming child logs into the terminal view.
// Technical description: spawns configured child processes, attaches UTF-8 line buffers to stdout/stderr, executes /r api and /r ui restarts via SIGTERM and respawn, and cleans up supervised children on shutdown.
export function createForegroundController({
  serviceDefinitions = definitions,
  output = process.stdout,
  projectRoot = process.cwd(),
  getGitInfo
} = {}) {
  const controllerChildren = new Map();
  const controllerState = new Map(Object.keys(serviceDefinitions).map((name) => [name, "starting"]));
  const controllerLogs = [];
  let controllerShuttingDown = false;
  const view = createForegroundView({
    children: controllerChildren,
    serviceState: controllerState,
    logLines: controllerLogs,
    suggestions,
    isActive: () => !controllerShuttingDown,
    output,
    projectRoot,
    getGitInfo
  });
  // Appends sanitized log lines from a supervised service into the controller log buffer.
  function recordLog(name, value) {
    const plain = String(value).replace(ansiPattern, "").replace(oscPattern, "");
    for (const line of plain.replace(/\r/g, "").split("\n")) {
      if (line) controllerLogs.push({ name, line });
    }
    while (controllerLogs.length > 2000) controllerLogs.shift();
  }
  // Spawns a supervised child service and wires its stdout/stderr streams into the log buffer.
  function startService(name) {
    if (controllerChildren.has(name)) return controllerChildren.get(name);
    const definition = serviceDefinitions[name];
    const child = spawn(definition.command, definition.args, {
      cwd: definition.cwd ?? projectRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(definition.env ?? {}), ...(name === "ui" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}) }
    });
    controllerChildren.set(name, child);
    controllerState.set(name, "running");
    for (const stream of [child.stdout, child.stderr]) {
      const receive = createForegroundLogReceiver((line) => recordLog(name, line));
      stream.on("data", receive);
      stream.once("end", receive.finish);
    }
    child.once("exit", (code, signal) => {
      if (controllerChildren.get(name) !== child) return;
      controllerChildren.delete(name);
      controllerState.set(name, "exited");
      if (!controllerShuttingDown) recordLog(name, `exited (${signal ?? code ?? "unknown"})`);
    });
    recordLog(name, `started (pid ${child.pid})`);
    return child;
  }
  // Stops a supervised child service with SIGTERM and waits for process exit.
  async function stopService(name) {
    const child = controllerChildren.get(name);
    if (!child) return;
    controllerChildren.delete(name);
    controllerState.set(name, "stopped");
    if (!child.killed && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise((resolveExit) => child.once("exit", resolveExit));
    }
    recordLog(name, "stopped");
  }
  // Restarts a supervised child service by stopping the current PID and spawning a replacement.
  async function restartSupervisedService(name) {
    recordLog("SYSTEM", `${name}: restarting...`);
    await stopService(name);
    if (!controllerShuttingDown) {
      controllerState.set(name, "running");
      startService(name);
      recordLog("SYSTEM", `${name}: restarted successfully (pid ${controllerChildren.get(name)?.pid ?? "unknown"})`);
    }
  }
  // Stops all supervised services and marks the controller as shut down.
  async function shutdownController() {
    if (controllerShuttingDown) return;
    controllerShuttingDown = true;
    await Promise.all([...controllerChildren.keys()].map((name) => stopService(name)));
  }
  // Executes an interactive command (/r api, /r ui, /r watcher, /q, etc.) against this controller.
  function runCommand(rawInput) {
    return executeForegroundCommand(rawInput, {
      onShutdown: () => shutdownController(),
      onRestart: (service) => restartSupervisedService(service),
      onHelp: (message) => recordLog("SYSTEM", message)
    });
  }
  return Object.freeze({
    children: controllerChildren,
    serviceState: controllerState,
    logLines: controllerLogs,
    start: startService,
    stop: stopService,
    restartService: restartSupervisedService,
    shutdown: shutdownController,
    executeCommand: runCommand,
    render: view.render
  });
}

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const { render } = createForegroundView({ children, serviceState, logLines, suggestions, isActive: () => interactive && !shuttingDown });
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.chdir(new URL("../..", import.meta.url).pathname);
  if (!interactive) {
    for (const name of Object.keys(definitions)) {
      const definition = definitions[name];
      const child = spawn(definition.command, definition.args, { stdio: ["ignore", "pipe", "pipe"] });
      children.set(name, child);
      attachServiceOutput(child, name);
    }
    process.once("SIGINT", () => process.exit(0));
    process.once("SIGTERM", () => process.exit(0));
  } else {
    runInteractive();
  }
}

// Summary: Starts raw-mode input handling and the interactive redraw loop.
function runInteractive() {
  const state = { input: "", cursor: 0, history: [], historyIndex: -1, scrollBack: 0, copyMode: false };
  // Capture wheel events directly so the terminal cannot scroll the entire TUI.
  process.stdout.write("\x1b[?1049h\x1b[?1007l\x1b[?7l\x1b[?1015l\x1b[?1016l\x1b[?1006h\x1b[?1000h\x1b[?1002h\x1b[2J\x1b[H\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  log("SYSTEM", FOREGROUND_STARTUP_MESSAGE);
  for (const name of Object.keys(definitions)) start(name);
  render(state);

  const statusTimer = setInterval(() => render(state), 2000);
  statusTimer.unref?.();
  process.stdout.on("resize", () => render(state));

  const selection = createMouseSelection({ state, output: process.stdout });
  const parser = createKeyParser({
    onMouse: selection.onMouse,
    onKey: (char) => handleKey(char, state),
    onWheel: (delta) => { state.scrollBack = Math.max(0, (state.scrollBack ?? 0) + delta * 3); },
    onEscape: (sequence) => handleEscape(sequence, state)
  });
  process.stdin.on("data", (chunk) => {
    if (state.copyMode) {
      exitCopyMode(state);
      render(state);
      return;
    }
    parser.push(chunk);
    render(state);
  });

  // Summary: Submits the current input as a controller command.
  async function submit() {
    const value = state.input.trim();
    state.input = "";
    state.cursor = 0;
    state.historyIndex = -1;
    if (!value) return;
    state.history.unshift(value);
    await executeForegroundCommand(value, {
      onShutdown: () => shutdown(),
      onRestart: (service) => restartService(service),
      onCopy: () => enterCopyMode(state),
      onSave: (targetPath) => saveLogs(targetPath),
      onHelp: (message) => log("SYSTEM", message)
    });
  }

  // Summary: Applies a keypress to the input buffer with editing shortcuts.
  function handleKey(char, state) {
    if (char === "\r" || char === "\n") { void submit(); return; }
    if (char === "\x03") { void shutdown(); return; }
    if (char === "\x10" || char === "\x0e") { recallHistory(char === "\x10" ? 1 : -1, state); return; }
    if (char === "\x7f") {
      if (state.cursor > 0) {
        state.input = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
        state.cursor -= 1;
      }
      return;
    }
    if (char === "\x15") { state.input = ""; state.cursor = 0; return; }
    if (char === "\x17") {
      const before = state.input.slice(0, state.cursor).replace(/\S+\s*$/, "");
      state.cursor = before.length;
      state.input = before + state.input.slice(state.cursor);
      return;
    }
    if (char === "\t") {
      const match = suggestions.find((item) => item.startsWith(state.input) && item !== state.input);
      if (match) { state.input = match; state.cursor = match.length; }
      return;
    }
    if (char < " " || char === "\x7f") return;
    state.input = state.input.slice(0, state.cursor) + char + state.input.slice(state.cursor);
    state.cursor += 1;
  }

  // Summary: Keeps terminal wheel and paging inside the log viewport.
  function handleEscape(sequence, state) {
    if (sequence === "\x1b[A" || sequence === "\x1b[5~") state.scrollBack += sequence === "\x1b[A" ? 3 : state.layout?.logCapacity ?? 10;
    else if (sequence === "\x1b[B" || sequence === "\x1b[6~") state.scrollBack = Math.max(0, state.scrollBack - (sequence === "\x1b[B" ? 3 : state.layout?.logCapacity ?? 10));
    else if (sequence === "\x1b[C") {
      state.cursor = Math.min(state.input.length, state.cursor + 1);
    } else if (sequence === "\x1b[D") {
      state.cursor = Math.max(0, state.cursor - 1);
    } else if (sequence === "\x1b[H" || sequence === "\x1b[F") {
      state.scrollBack = 0;
    }
  }

  // Summary: Recalls commands without stealing arrow events sent by terminal wheel scrolling.
  function recallHistory(direction, state) {
    state.historyIndex = Math.max(-1, Math.min(state.history.length - 1, state.historyIndex + direction));
    state.input = state.historyIndex < 0 ? "" : state.history[state.historyIndex];
    state.cursor = state.input.length;
  }

  // Summary: Freezes the screen for terminal-native mouse selection and copying.
  function enterCopyMode(state) {
    state.copyMode = true;
    process.stdout.write("\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l");
    renderCopyScreen();
  }

  // Summary: Redraws plain log text without positioning so selection works.
  function renderCopyScreen() {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
    for (const entry of logLines.slice(-200)) process.stdout.write(`${formatForegroundLine(entry, { color: false })}\n`);
    process.stdout.write("\n\x1b[30;48;5;255m COPY MODE — select with mouse, then press any key to return \x1b[0m\n");
  }

  // Summary: Leaves copy mode and restores the live view.
  function exitCopyMode(state) {
    state.copyMode = false;
    process.stdout.write("\x1b[?1049h\x1b[?7l\x1b[?1006h\x1b[?1000h\x1b[?1002h");
  }

  // Summary: Dumps buffered logs to a file for later copying.
  function saveLogs(path) {
    try {
      const content = logLines.map((entry) => formatForegroundLine(entry, { color: false })).join("\n");
      writeFileSync(path, `${content}\n`);
      log("SYSTEM", `Saved ${logLines.length} lines to ${path}`);
    } catch (error) {
      log("SYSTEM", `Save failed: ${error.message}`);
    }
  }
}

function start(name) {
  if (children.has(name)) return;
  const definition = definitions[name];
  const child = spawn(definition.command, definition.args, {
    // Keep stdin exclusively for the controller prompt; services only need log output.
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(name === "ui" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}) }
  });
  children.set(name, child);
  serviceState.set(name, "running");
  attachServiceOutput(child, name);
  child.once("exit", (code, signal) => {
    if (children.get(name) !== child) return;
    children.delete(name);
    serviceState.set(name, "exited");
    if (!shuttingDown) log(name, `exited (${signal ?? code ?? "unknown"})`);
  });
  log(name, `started (pid ${child.pid})`);
}

async function restartService(name) {
  log("SYSTEM", `${name}: restarting...`);
  await stop(name);
  if (!shuttingDown) {
    serviceState.set(name, "running");
    start(name);
    log("SYSTEM", `${name}: restarted successfully (pid ${children.get(name)?.pid ?? "unknown"})`);
  }
}

async function stop(name) {
  const child = children.get(name);
  if (!child) return;
  children.delete(name);
  serviceState.set(name, "stopped");
  if (!child.killed) child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  log(name, "stopped");
}

function log(name, value) {
  const plain = String(value).replace(ansiPattern, "").replace(oscPattern, "");
  for (const line of plain.replace(/\r/g, "").split("\n")) {
    if (line) {
      logLines.push({ name, line });
      if (!interactive) process.stdout.write(`${formatForegroundLine({ name, line }, { color: false })}\n`);
    }
  }
  while (logLines.length > 2000) logLines.shift();
}

/** Gives each service stream its own UTF-8 line buffer so concurrent stdout
 * and stderr never share partial messages or duplicate source prefixes. */
function attachServiceOutput(child, name) {
  for (const stream of [child.stdout, child.stderr]) {
    const receive = createForegroundLogReceiver((line) => log(name, line));
    stream.on("data", receive);
    stream.once("end", receive.finish);
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-silent-catch -- Stdin may already be closed during shutdown.
  try { process.stdin.setRawMode(false); } catch { /* stdin already closed. */ }
  process.stdout.write("\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l\x1b[?25h\n");
  await Promise.all([...children.keys()].map((name) => stop(name)));
  const leftovers = Object.keys(definitions).flatMap((name) => findMatchingPids(name));
  for (const pid of leftovers) {
    // eslint-disable-next-line no-silent-catch -- Process already exited between scan and SIGTERM.
    try { process.kill(pid, "SIGTERM"); } catch { /* Process already exited. */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 750));
  for (const pid of leftovers) {
    if (alive(pid)) {
      // eslint-disable-next-line no-silent-catch -- Process already exited between scan and SIGKILL.
      try { process.kill(pid, "SIGKILL"); } catch { /* Process already exited. */ }
    }
  }
  process.exit(0);
}

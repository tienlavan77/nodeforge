// Summary: Runs the API, watcher, and web development services under one interactive controller.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import process from "node:process";
import { createKeyParser } from "./dev-foreground-keys.mjs";
import { createForegroundView } from "./dev-foreground-view.mjs";
import { alive, findMatchingPids } from "./dev-foreground-process.mjs";

process.chdir(new URL("../..", import.meta.url).pathname);

const definitions = {
  api: { command: process.execPath, args: ["backend/scripts/start-control-api.mjs"] },
  watcher: { command: process.execPath, args: ["backend/scripts/start-project-watcher.mjs"] },
  ui: { command: "pnpm", args: ["--dir", "ui/nextjs", "dev"] }
};
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const ansiPattern = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const oscPattern = new RegExp(`${ESC}\\][^${BEL}]*(?:${BEL}|${ESC}\\\\)`, "g");
const suggestions = ["/q quit", "/r api restart", "/r watcher restart", "/r ui restart", "/copy", "/save log.txt"];
const children = new Map();
const serviceState = new Map(Object.keys(definitions).map((name) => [name, "starting"]));
const logLines = [];
let shuttingDown = false;

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
const { render } = createForegroundView({ children, serviceState, logLines, suggestions, isActive: () => interactive && !shuttingDown });
if (!interactive) {
  for (const name of Object.keys(definitions)) {
    const definition = definitions[name];
    const child = spawn(definition.command, definition.args, { stdio: ["ignore", "inherit", "inherit"] });
    children.set(name, child);
  }
  process.once("SIGINT", () => process.exit(0));
  process.once("SIGTERM", () => process.exit(0));
} else {
  runInteractive();
}

// Summary: Starts raw-mode input handling and the interactive redraw loop.
function runInteractive() {
  const state = { input: "", cursor: 0, history: [], historyIndex: -1, scrollBack: 0, copyMode: false };
  // Capture wheel events directly so the terminal cannot scroll the entire TUI.
  process.stdout.write("\x1b[?1049h\x1b[?1007l\x1b[?7l\x1b[?1002l\x1b[?1015l\x1b[?1016l\x1b[?1006h\x1b[?1000h\x1b[2J\x1b[H\x1b[?25l");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  log("SYSTEM", "Services starting: api, watcher, ui");
  for (const name of Object.keys(definitions)) start(name);
  render(state);

  const statusTimer = setInterval(() => render(state), 2000);
  statusTimer.unref?.();
  process.stdout.on("resize", () => render(state));

  const parser = createKeyParser({
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
    const lower = value.toLowerCase();
    if (lower === "/q" || lower === "/quit" || lower === "exit") return shutdown();
    const restart = lower.match(/^\/r\s+(api|watcher|ui)$/);
    if (restart) await restartService(restart[1]);
    else if (lower === "/copy") enterCopyMode(state);
    else if (lower.startsWith("/save")) saveLogs(value.slice(5).trim() || "dev-foreground.log");
    else log("SYSTEM", "Commands: /q quit · /r api|watcher|ui restart · /copy select · /save <file>");
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
    process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l");
    renderCopyScreen();
  }

  // Summary: Redraws plain log text without positioning so selection works.
  function renderCopyScreen() {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H");
    for (const entry of logLines.slice(-200)) process.stdout.write(`[${entry.name.toUpperCase()}] ${entry.line}\n`);
    process.stdout.write("\n\x1b[30;48;5;255m COPY MODE — select with mouse, then press any key to return \x1b[0m\n");
  }

  // Summary: Leaves copy mode and restores the live view.
  function exitCopyMode(state) {
    state.copyMode = false;
    process.stdout.write("\x1b[?1049h\x1b[?7l\x1b[?1006h\x1b[?1000h");
  }

  // Summary: Dumps buffered logs to a file for later copying.
  function saveLogs(path) {
    try {
      const content = logLines.map((entry) => `[${entry.name.toUpperCase()}] ${entry.line}`).join("\n");
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
  child.stdout.on("data", (chunk) => log(name, chunk));
  child.stderr.on("data", (chunk) => log(name, chunk));
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
    if (line) logLines.push({ name, line });
  }
  while (logLines.length > 2000) logLines.shift();
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-silent-catch -- Stdin may already be closed during shutdown.
  try { process.stdin.setRawMode(false); } catch { /* stdin already closed. */ }
  process.stdout.write("\x1b[?1000l\x1b[?1006l\x1b[?7h\x1b[?1049l\x1b[?25h\n");
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

// Summary: Runs the API, watcher, and web development services under one interactive controller.
import { execFileSync, spawn } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { createKeyParser } from "./dev-foreground-keys.mjs";

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
const serviceColors = { api: "36", watcher: "35", ui: "32", SYSTEM: "33" };
const suggestions = ["/q quit", "/r api restart", "/r watcher restart", "/r ui restart", "/copy", "/save log.txt"];
const children = new Map();
const serviceState = new Map(Object.keys(definitions).map((name) => [name, "starting"]));
const logLines = [];
let shuttingDown = false;
let gitCache = { at: 0, text: "git --" };
let embeddingCache = { at: 0, text: "" };

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
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
  process.stdout.write("\x1b[2J\x1b[H\x1b[3J\x1b[?25l\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1015l\x1b[?1016l");
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

  // Summary: Applies arrow-key navigation and history recall.
  function handleEscape(sequence, state) {
    if (sequence === "\x1b[A") {
      if (state.history.length > 0 && state.historyIndex < state.history.length - 1) {
        state.historyIndex += 1;
        state.input = state.history[state.historyIndex];
        state.cursor = state.input.length;
      }
    } else if (sequence === "\x1b[B") {
      if (state.historyIndex > 0) {
        state.historyIndex -= 1;
        state.input = state.history[state.historyIndex];
        state.cursor = state.input.length;
      } else { state.historyIndex = -1; state.input = ""; state.cursor = 0; }
    } else if (sequence === "\x1b[C") {
      state.cursor = Math.min(state.input.length, state.cursor + 1);
    } else if (sequence === "\x1b[D") {
      state.cursor = Math.max(0, state.cursor - 1);
    } else if (sequence === "\x1b[H" || sequence === "\x1b[F") {
      state.scrollBack = 0;
    }
  }

  // Summary: Freezes the screen for terminal-native mouse selection and copying.
  function enterCopyMode(state) {
    state.copyMode = true;
    renderCopyScreen();
  }

  // Summary: Redraws plain log text without positioning so selection works.
  function renderCopyScreen() {
    process.stdout.write("\x1b[?25l\x1b[2J\x1b[H\x1b[3J");
    for (const entry of logLines.slice(-200)) process.stdout.write(`[${entry.name.toUpperCase()}] ${entry.line}\n`);
    process.stdout.write("\n\x1b[30;48;5;255m COPY MODE — select with mouse, then press any key to return \x1b[0m\n");
  }

  // Summary: Leaves copy mode and restores the live view.
  function exitCopyMode(state) {
    state.copyMode = false;
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

// Summary: Redraws the log area, status bar, and boxed prompt like the Claude Code CLI.
function render(state) {
  if (!interactive || shuttingDown || !state) return;
  const rows = Math.max(10, process.stdout.rows ?? 24);
  const width = Math.max(40, process.stdout.columns ?? 80);
  const activeSuggestions = state.input.startsWith("/")
    ? suggestions.filter((item) => item.startsWith(state.input))
    : [];
  const suggestionRows = activeSuggestions.length > 0 ? activeSuggestions.length + 1 : 0;
  // Layout: logs fill the top, then embedding progress, status bar, suggestion list, and a 3-row input box.
  const boxTop = rows - 2;
  const suggestionTop = boxTop - suggestionRows;
  const statusRow = suggestionTop - 2;
  const embeddingRow = suggestionTop - 1;
  const logCapacity = Math.max(1, statusRow - 1);

  process.stdout.write("\x1b[?25l");
  process.stdout.write("\x1b[1;1H");
  const maxBack = Math.max(0, logLines.length - logCapacity);
  if (state) state.scrollBack = Math.min(Math.max(state.scrollBack ?? 0, 0), maxBack);
  const back = state?.scrollBack ?? 0;
  const visible = logLines.slice(Math.max(0, logLines.length - logCapacity - back), logLines.length - back);
  state.layout = { logCapacity, back, width };
  for (let row = 1; row <= logCapacity; row += 1) {
    const entry = visible[row - 1];
    process.stdout.write("\x1b[2K");
    if (entry) {
      const color = serviceColors[entry.name.toUpperCase()] ?? serviceColors[entry.name] ?? "37";
      const label = `[${entry.name.toUpperCase()}]`;
      process.stdout.write(`\x1b[${color}m${label}\x1b[0m ${entry.line.slice(0, width - label.length - 1)}\n`);
    } else process.stdout.write("\n");
  }
  if (back > 0) process.stdout.write(`\x1b[${logCapacity};${Math.max(1, width - 22)}H\x1b[30;48;5;255m ▲ ${back} lines (scroll down) \x1b[0m`);
  process.stdout.write(`\x1b[${statusRow};1H\x1b[2K${statusLine().slice(0, width)}`);
  const embeddingProgress = embeddingProgressLine(embeddingRow);
  if (embeddingProgress) process.stdout.write(`\x1b[${embeddingRow};1H\x1b[2K${embeddingProgress.slice(0, width)}`);
  else process.stdout.write(`\x1b[${embeddingRow};1H\x1b[2K`);
  if (suggestionRows > 0) {
    process.stdout.write(`\x1b[${suggestionTop};1H\x1b[2K\x1b[38;5;245m  commands\x1b[0m`);
    activeSuggestions.forEach((item, index) => {
      process.stdout.write(`\x1b[${suggestionTop + 1 + index};1H\x1b[2K  \x1b[36m${item}\x1b[0m`);
    });
  }
  drawInputBox(state, boxTop, width);
  process.stdout.write("\x1b[?25h");
}

// Summary: Draws the rounded input box with placeholder, scrolling text, and cursor.
function drawInputBox(state, boxTop, width) {
  const inner = width - 4;
  const prompt = "› ";
  const maxText = Math.max(1, inner - prompt.length);
  let offset = 0;
  if (state.cursor - offset >= maxText) offset = state.cursor - maxText + 1;
  if (offset > state.cursor) offset = state.cursor;
  const visibleText = state.input.slice(offset, offset + maxText);
  const cursorCol = 3 + prompt.length + (state.cursor - offset);

  process.stdout.write(`\x1b[${boxTop};1H\x1b[2K\x1b[38;5;245m╭${"─".repeat(width - 2)}╮\x1b[0m`);
  process.stdout.write(`\x1b[${boxTop + 1};1H\x1b[2K\x1b[38;5;245m│\x1b[0m \x1b[36m${prompt}\x1b[0m`);
  if (state.input.length === 0) {
    process.stdout.write(`\x1b[38;5;245mType a command…  /q quit · /r api|watcher|ui restart\x1b[0m`);
  } else {
    process.stdout.write(visibleText);
  }
  process.stdout.write(`\x1b[${boxTop + 1};${width}H\x1b[38;5;245m│\x1b[0m`);
  process.stdout.write(`\x1b[${boxTop + 2};1H\x1b[2K\x1b[38;5;245m╰${"─".repeat(width - 2)}╯\x1b[0m`);
  process.stdout.write(`\x1b[${boxTop + 1};${Math.min(cursorCol, width - 1)}H`);
}

// Summary: Builds the one-line status bar with git, ports, and service health.
function statusLine() {
  const dots = [...serviceState.entries()].map(([name, status]) => {
    const child = children.get(name);
    const stats = child ? ` ${processStats(child.pid)}` : "";
    const dot = status === "running" ? "\x1b[32m●\x1b[0m" : "\x1b[31m●\x1b[0m";
    return `${dot} ${name}${stats}`;
  });
  const apiPort = process.env.NODE_CONTROL_PORT ?? "3100";
  const git = gitInfo();
  return `\x1b[38;5;245mnodeforge dev · ${git} · api :${apiPort} · ui :3000 · ${dots.join(" · ")} · \x1b[36mTab complete · ↑ history\x1b[0m`;
}

// Summary: Reads the current git branch and dirty marker with caching.
function gitInfo() {
  if (Date.now() - gitCache.at > 5000) {
    try {
      const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
      const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
      gitCache = { at: Date.now(), text: `${branch}${dirty ? "*" : ""}` };
    // eslint-disable-next-line no-silent-catch -- Git status probe: fallback text is the designed degraded display.
    } catch { gitCache = { at: Date.now(), text: "git --" }; }
  }
  return gitCache.text;
}

function processStats(pid) {
  try {
    const rss = Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
    return `${(rss / 1024).toFixed(0)}MB`;
  // eslint-disable-next-line no-silent-catch -- Procfs probe: short-lived PIDs vanish mid-read by design.
  } catch { return "--"; }
}

// Summary: Reads embedding queue counts and renders a progress bar with throughput.
function embeddingProgressLine() {
  if (Date.now() - embeddingCache.at < 2000) return embeddingCache.text;
  let text = "";
  try {
    const database = new DatabaseSync(join(process.cwd(), ".forge", "runtime", "wc", "index.db"), { readOnly: true });
    try {
      const counts = Object.fromEntries(
        database.prepare("SELECT status, COUNT(*) AS count FROM embedding_jobs GROUP BY status").all()
          .map((row) => [row.status, Number(row.count)])
      );
      const done = counts.completed ?? 0;
      const failed = counts.failed ?? 0;
      const active = (counts.pending ?? 0) + (counts.retry_wait ?? 0) + (counts.processing ?? 0);
      const total = done + failed + active;
      const vectors = Number(database.prepare("SELECT COUNT(*) AS count FROM symbol_embeddings").all()[0]?.count ?? 0);
      if (total > 0) {
        const width = 12;
        const filled = Math.round((width * (done + failed)) / total);
        const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
        const percent = Math.round(((done + failed) / total) * 100);
        const previous = embeddingCache.counts;
        let rate = "";
        if (previous && embeddingCache.at > 0) {
          const elapsed = (Date.now() - embeddingCache.at) / 1000;
          const delta = done - previous.done;
          if (elapsed > 0 && delta >= 0) rate = ` · ${(delta / elapsed).toFixed(1)}/s`;
        }
        embeddingCache.counts = { done };
        const failedPart = failed > 0 ? ` · \x1b[31m${failed} failed\x1b[0m` : "";
        text = `\x1b[38;5;245membed \x1b[36m${bar}\x1b[0m\x1b[38;5;245m ${percent}% · ${done}/${total} done · ${active} queued · ${vectors} vectors${rate}${failedPart}\x1b[0m`;
      }
    } finally {
      database.close();
    }
  // eslint-disable-next-line no-silent-catch -- SQLite probe: watcher DB may not exist yet on first run.
  } catch { text = ""; }
  embeddingCache = { at: Date.now(), text, counts: embeddingCache.counts };
  return text;
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  // eslint-disable-next-line no-silent-catch -- Stdin may already be closed during shutdown.
  try { process.stdin.setRawMode(false); } catch { /* stdin already closed. */ }
  process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l\x1b[?1015l\x1b[?1016l\x1b[?25h\n");
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

function findMatchingPids(name) {
  const patterns = {
    api: ["backend/scripts/start-control-api.mjs"],
    watcher: ["backend/scripts/start-project-watcher.mjs"],
    ui: ["next-server", "ui/nextjs", "next dev"]
  }[name];
  const pids = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    if (pid === process.pid) continue;
    try {
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ");
      if (patterns.some((pattern) => command.includes(pattern))) pids.push(pid);
    // eslint-disable-next-line no-silent-catch -- Process may exit while the PID list is being scanned.
    } catch { /* Process may exit while the list is being scanned. */ }
  }
  return pids;
}

// eslint-disable-next-line no-silent-catch -- Liveness probe: ESRCH means not-alive, which is the answer.
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

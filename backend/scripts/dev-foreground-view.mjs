// Renders the development log viewport while keeping status and command input fixed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

const serviceColors = { api: "36", watcher: "35", ui: "32", SYSTEM: "33" };
let gitCache = { at: 0, text: "git --" };
let embeddingCache = { at: 0, text: "" };

// Creates a terminal view over the shared service and log state.
export function createForegroundView({ children, serviceState, logLines, suggestions, isActive, output = process.stdout, getGitInfo, getEmbeddingProgress }) {
  const readGitInfo = getGitInfo ?? gitInfo;
  const readEmbeddingProgress = getEmbeddingProgress ?? embeddingProgressLine;
// Summary: Redraws the log area, status bar, and boxed prompt like the Claude Code CLI.
function render(state) {
  if (!isActive() || !state || state.copyMode) return;
  const rows = Math.max(10, output.rows ?? 24);
  const width = Math.max(40, output.columns ?? 80);
  // Reserve the bottom rows once; suggestions take space only from the log viewport.
  const boxTop = rows - 2;
  const statusRow = boxTop - 2;
  const embeddingRow = boxTop - 1;
  const activeSuggestions = state.input.startsWith("/")
    ? suggestions.filter((item) => item.startsWith(state.input)).slice(0, Math.max(0, statusRow - 3))
    : [];
  const suggestionRows = activeSuggestions.length > 0 ? activeSuggestions.length + 1 : 0;
  const suggestionTop = statusRow - suggestionRows;
  const logCapacity = Math.max(1, suggestionTop - 1);

  output.write("\x1b[?25l");
  output.write("\x1b[1;1H");
  const maxBack = Math.max(0, logLines.length - logCapacity);
  if (state) state.scrollBack = Math.min(Math.max(state.scrollBack ?? 0, 0), maxBack);
  const back = state?.scrollBack ?? 0;
  const visible = logLines.slice(Math.max(0, logLines.length - logCapacity - back), logLines.length - back);
  state.layout = { logCapacity, back, width };
  for (let row = 1; row <= logCapacity; row += 1) {
    const entry = visible[row - 1];
    output.write("\x1b[2K");
    if (entry) {
      const color = serviceColors[entry.name.toUpperCase()] ?? serviceColors[entry.name] ?? "37";
      const label = `[${entry.name.toUpperCase()}]`;
      output.write(`\x1b[${color}m${label}\x1b[0m ${entry.line.slice(0, width - label.length - 1)}\n`);
    } else output.write("\n");
  }
  if (back > 0) output.write(`\x1b[${logCapacity};${Math.max(1, width - 22)}H\x1b[30;48;5;255m ▲ ${back} lines (scroll down) \x1b[0m`);
  output.write(`\x1b[${statusRow};1H\x1b[2K${statusLine().slice(0, width)}`);
  const embeddingProgress = readEmbeddingProgress();
  if (embeddingProgress) output.write(`\x1b[${embeddingRow};1H\x1b[2K${embeddingProgress.slice(0, width)}`);
  else output.write(`\x1b[${embeddingRow};1H\x1b[2K`);
  if (suggestionRows > 0) {
    output.write(`\x1b[${suggestionTop};1H\x1b[2K\x1b[38;5;245m  commands\x1b[0m`);
    activeSuggestions.forEach((item, index) => {
      output.write(`\x1b[${suggestionTop + 1 + index};1H\x1b[2K  \x1b[36m${item}\x1b[0m`);
    });
  }
  drawInputBox(state, boxTop, width);
  output.write("\x1b[?25h");
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

  output.write(`\x1b[${boxTop};1H\x1b[2K\x1b[38;5;245m╭${"─".repeat(width - 2)}╮\x1b[0m`);
  output.write(`\x1b[${boxTop + 1};1H\x1b[2K\x1b[38;5;245m│\x1b[0m \x1b[36m${prompt}\x1b[0m`);
  if (state.input.length === 0) {
    output.write(`\x1b[38;5;245mType a command…  /q quit · /r api|watcher|ui restart\x1b[0m`);
  } else {
    output.write(visibleText);
  }
  output.write(`\x1b[${boxTop + 1};${width}H\x1b[38;5;245m│\x1b[0m`);
  output.write(`\x1b[${boxTop + 2};1H\x1b[2K\x1b[38;5;245m╰${"─".repeat(width - 2)}╯\x1b[0m`);
  output.write(`\x1b[${boxTop + 1};${Math.min(cursorCol, width - 1)}H`);
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
  const git = readGitInfo();
  return `\x1b[38;5;245mnodeforge dev · ${git} · api :${apiPort} · ui :3000 · ${dots.join(" · ")} · \x1b[36mTab complete · ↑↓ logs · Ctrl-P/N history\x1b[0m`;
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

  return Object.freeze({ render });
}

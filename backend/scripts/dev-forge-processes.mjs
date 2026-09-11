// Summary: Manages Forge development service processes and keeps foreground input separate from child logs.

import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import process from "node:process";
import readline from "node:readline";

process.chdir(resolve(new URL("../..", import.meta.url).pathname));
const runtimeDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".forge", "runtime", "nf");
const processDir = join(runtimeDir, "processes");
const definitions = {
  api: { args: ["backend/scripts/start-control-api.mjs"], log: "api.log" },
  next: { command: "pnpm", args: ["--dir", "ui/nextjs", "dev"], log: "next.log" },
};
const command = process.argv[2];
const [, service, action, mode] = command?.match(/^(api|next):(start|stop|restart)(?::(foreground))?$/) ?? [];

if (command === "start") { start("api"); start("next"); }
else if (command === "shutdown" || command === "shutdow") { await stop("next"); await stop("api"); }
else if (service && action === "start") await start(service);
else if (service && action === "stop") await stop(service);
else if (service && action === "restart") { await stop(service); await start(service, { foreground: mode === "foreground" }); }
else { console.error("Usage: api|next:(start|stop|restart[:foreground]), start, shutdown"); process.exitCode = 2; }

function pidPath(name) { return join(processDir, `${name}.pid`); }
function readPid(name) { try { const pid = Number(readFileSync(pidPath(name), "utf8")); return Number.isInteger(pid) && pid > 0 ? pid : null; } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
async function start(name, { foreground = false } = {}) {
  const oldPid = readPid(name);
  if (oldPid && alive(oldPid)) { console.log(`${name}: already running (pid ${oldPid})`); return; }
  if (oldPid) try { unlinkSync(pidPath(name)); } catch {}
  mkdirSync(processDir, { recursive: true });
  const def = definitions[name];
  if (foreground) { await runForeground(name, def); return; }
  const log = openSync(join(processDir, def.log), "a");
  const child = spawn(def.command ?? process.execPath, def.args, { detached: true, stdio: ["ignore", log, log], env: { ...process.env, ...(name === "next" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}) } });
  closeSync(log); child.unref(); writeFileSync(pidPath(name), `${child.pid}\n`);
  console.log(`${name}: started (pid ${child.pid})`);
}
async function runForeground(name, def) {
  let restarting = true;
  while (restarting) {
    restarting = false;
    const child = spawn(def.command ?? process.execPath, def.args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(name === "next" ? { NEXT_TELEMETRY_DISABLED: "1" } : {}) } });
    console.log(`${name}: started in foreground (pid ${child.pid}); commands: r=restart, q=quit, Ctrl-C=quit`);
    let announced = false;
    const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const prompt = "\x1b[1;36mforge-api>\x1b[0m ";
    const statusStyle = "\x1b[48;5;250m\x1b[38;5;238m";
    const terminalRows = Math.max(3, process.stdout.rows ?? 24);
    const logRows = terminalRows - 2;
    const statusRow = terminalRows - 1;
    const promptRow = terminalRows;
    const redrawPrompt = () => { if (interactive) { readline.clearLine(process.stdout, 0); process.stdout.write("\r" + prompt + "\x1b[?25h"); } };
    const forward = (chunk) => {
      const text = String(chunk);
      if (interactive) renderLog(text); else process.stdout.write(text);
      if (!announced && /\blisten(?:ing|ed)\b/i.test(text)) { announced = true; process.stdout.write("\x07"); process.stdout.write("\x1b]0;🔔 NodeForge API listening\x07"); }
    };
    child.stdout.on("data", forward); child.stderr.on("data", (chunk) => { if (interactive) renderLog(String(chunk)); else process.stderr.write(chunk); });
    let requested = null;
    const startedAt = Date.now();
    let previousCpu = null;
    const readStats = () => {
      try {
        const stat = readFileSync(`/proc/${child.pid}/stat`, "utf8");
        const values = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
        const cpu = Number(values[11] ?? 0) + Number(values[12] ?? 0);
        const total = readFileSync("/proc/stat", "utf8").match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).reduce((sum, value) => sum + Number(value), 0) ?? 0;
        const rss = Number(readFileSync(`/proc/${child.pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)\s+kB$/m)?.[1] ?? 0);
        // /proc values are jiffies; divide process time by host time once to get 0-100%.
        const cpuPercent = previousCpu && total > previousCpu.total && cpu >= previousCpu.cpu
          ? Math.min(100, Math.max(0, ((cpu - previousCpu.cpu) / (total - previousCpu.total)) * 100))
          : 0;
        previousCpu = { cpu, total };
        const elapsed = Math.floor((Date.now() - startedAt) / 1000);
        return ` PID ${child.pid} | RAM ${(rss / 1024).toFixed(1)} MB | CPU ${cpuPercent.toFixed(1)}% | Uptime ${String(Math.floor(elapsed / 3600)).padStart(2, "0")}:${String(Math.floor((elapsed % 3600) / 60)).padStart(2, "0")}:${String(elapsed % 60).padStart(2, "0")} `;
      } catch { return ` PID ${child.pid} | RAM -- | CPU -- | Uptime -- `; }
    };
    const drawStatus = () => {
      if (!interactive) return;
      const width = Math.max(40, process.stdout.columns ?? 80);
      const text = readStats().slice(0, width - 1).padEnd(width - 1, " ");
      // Repaint the reserved status row while preserving the prompt cursor below it.
      process.stdout.write("\x1b7\x1b[" + statusRow + ";1H\x1b[2K" + statusStyle + text + "\x1b[0m\x1b8");
    };
    const renderLog = (text) => {
      process.stdout.write("\x1b7\x1b[" + logRows + ";1H\x1b[2K" + text + (text.endsWith("\n") ? "" : "\n") + "\x1b8");
      drawStatus();
    };
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: interactive, prompt });
    process.stdin.resume();
    if (interactive) { process.stdout.write("\x1b[1;" + logRows + "r\x1b[" + statusRow + ";1H\x1b[2K"); drawStatus(); process.stdout.write("\x1b[" + promptRow + ";1H"); rl.prompt(); }
    const statusTimer = interactive ? setInterval(drawStatus, 1000) : null;
    statusTimer?.unref?.();
    const terminate = () => { if (!child.killed) child.kill("SIGTERM"); };
    const onSignal = () => { requested = "quit"; terminate(); };
    process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
    const clearTerminal = () => {
      if (!interactive) return;
      process.stdout.write("\x1b[2J\x1b[H\x1b[3J");
    };
    const onLine = (line) => {
      const command = line.trim().toLowerCase();
      if (command === "r" || command === "restart") {
        requested = "restart";
        terminate();
      } else if (command === "q" || command === "quit" || command === "exit") {
        requested = "quit";
        clearTerminal();
        terminate();
      } else if (interactive) {
        renderLog("Commands: r=restart, q=quit");
        rl.prompt();
      }
    };
    rl.on("line", onLine);
    const result = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, signal) => resolve({ code, signal })); });
    if (statusTimer) clearInterval(statusTimer); if (interactive) process.stdout.write("\x1b[r\x1b[?25h\n"); rl.close(); process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    if (requested === "restart") { console.log(`${name}: restarting after clean shutdown`); restarting = true; }
    else if (requested === "quit") console.log(`${name}: stopped cleanly`);
    else if (result.signal) console.log(`${name}: stopped (${result.signal})`);
  }
}

async function stop(name) {
  const tracked = readPid(name);
  const pids = new Set(tracked ? [tracked] : []);
  if (name === "api") for (const pid of findApiPids()) pids.add(pid);
  if (!pids.size) { console.log(`${name}: not running`); if (name === "api") removeApiLock(); return; }
  for (const pid of pids) {
    if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; } console.log(`${name}: stopped (pid ${pid})`); }
  }
  try { unlinkSync(pidPath(name)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (name === "api") {
    await new Promise((resolve) => setTimeout(resolve, 500));
    removeApiLock();
  }
}

function findApiPids() {
  const result = [];
  for (const entry of readdirSync("/proc", { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    try {
      const command = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").replaceAll("\0", " ");
      const pid = Number(entry.name);
      if (pid !== process.pid && !command.includes("dev-forge-processes.mjs") && command.includes("backend/scripts/start-control-api.mjs")) result.push(pid);
    } catch { /* process exited during discovery */ }
  }
  return result;
}

function removeApiLock() {
  const lockPath = join(runtimeDir, ".nodeforge-control.lock");
  try { unlinkSync(lockPath); console.log("api: removed Control API lock"); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

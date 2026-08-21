import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";

loadNodeforgeEnv();

const stateDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".node-control");
const stateFile = join(stateDir, "dev-forge.pids.json");
const command = process.argv[2];

if (command === "--start") await start();
else if (command === "--stop") await stop();
else if (command === "--restart") { await stop(); await start(); }
else {
  console.error("Usage: npm run dev:forge -- --start|--stop|--restart");
  process.exitCode = 2;
}

async function start() {
  if (readState()) {
    console.log("Forge development processes are already running.");
    return;
  }
  mkdirSync(stateDir, { recursive: true });
  const logDir = join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const nodePid = launch(process.execPath, ["scripts/start-dev.mjs"], join(logDir, "node.log"));
  writeFileSync(stateFile, JSON.stringify({ nodePid, startedAt: new Date().toISOString() }, null, 2));
  console.log("Forge development started:");
  console.log(`  [RUNNING] Control API + source restart supervisor (pid ${nodePid})`);
  console.log("            http://127.0.0.1:3100");
  console.log(`  [RUNNING] Filesystem/index watcher (managed by supervisor ${nodePid})`);
  console.log("            project files -> indexer -> verification");
  console.log("  [NOT RUNNING] Vite Web UI (start separately with npm run dev:web)");
}

function launch(file, args, logPath) {
  const output = openSync(logPath, "a");
  const child = spawn(file, args, { detached: true, stdio: ["ignore", output, output], env: process.env });
  child.unref();
  closeSync(output);
  return child.pid;
}

async function stop() {
  const state = readState();
  if (!state) {
    console.log("Forge development processes are not running:");
    console.log("  [STOPPED] Control API + source restart supervisor (not found)");
    console.log("  [STOPPED] Vite Web UI (not managed by forge:start)");
    return;
  }
  console.log("Stopping Forge development processes:");
  console.log(`  [STOPPING] Control API + source restart supervisor (pid ${state.nodePid})`);
  console.log("  [STOPPING] Filesystem/index watcher (managed by supervisor)");
  for (const pid of [state.nodePid]) {
    if (!Number.isInteger(pid)) continue;
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if (error.code === "EPERM") {
        try { process.kill(pid, "SIGTERM"); } catch (directError) {
          if (directError.code !== "ESRCH") console.warn(`Could not stop process ${pid}: ${directError.message}`);
        }
      } else if (error.code !== "ESRCH") {
        console.warn(`Could not stop process group ${pid}: ${error.message}`);
      }
    }
  }
  try { unlinkSync(stateFile); } catch (error) { if (error.code !== "ENOENT") throw error; }
  console.log("  [STOPPED] Control API");
  console.log("  [STOPPED] Filesystem/index watcher");
  console.log("  [NOT STOPPED] Vite Web UI (not managed by forge:start)");
  console.log("Forge development processes stopped.");
  await new Promise((resolve) => setTimeout(resolve, 500));
}

function readState() {
  try {
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    if (Number.isInteger(state.nodePid) && isAlive(state.nodePid)) return state;
    unlinkSync(stateFile);
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`Ignoring invalid Forge state: ${error.message}`);
  }
  return null;
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

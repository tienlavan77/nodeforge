import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import process from "node:process";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";

loadNodeforgeEnv();

const stateDir = process.env.NODE_CONTROL_DATA_DIR ?? join(process.cwd(), ".forge", "runtime", "nf");
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
  console.log("Forge development started (VPS):");
  console.log(`  [RUNNING] Control API + source restart supervisor (pid ${nodePid})`);
  console.log("            http://127.0.0.1:3100  (scripts/start-dev.mjs -> scripts/start-control-api.mjs)");
  console.log("  [SEPARATE] Filesystem/index watcher — run separately: npm run dev:watcher");
  console.log("  [CLIENT]  Vite Web UI — runs on macOS: npm run dev:web (vite --host 127.0.0.1 --config web/vite.config.js)");
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
    console.log("  [SEPARATE] Filesystem/index watcher (not managed: pkill -f start-project-watcher)");
    console.log("  [CLIENT]  Vite Web UI (runs on macOS, not managed)");
    return;
  }
  console.log("Stopping Forge development processes:");
  console.log(`  [STOPPING] Control API + source restart supervisor (pid ${state.nodePid})`);
  console.log("  [LEAVING]  Filesystem/index watcher — stop separately: pkill -f start-project-watcher");
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
  console.log("  [STOPPED] Control API supervisor");
  console.log("  [NOT TOUCHED] Filesystem/index watcher (separate process)");
  console.log("  [NOT TOUCHED] Vite Web UI (client macOS)");
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

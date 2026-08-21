import { execFileSync, spawn } from "node:child_process";
import process from "node:process";
import chokidar from "chokidar";
import { loadNodeforgeEnv } from "./nodeforge-env.mjs";

loadNodeforgeEnv();

const controlPort = Number(process.env.NODE_CONTROL_PORT ?? 3100);

function freePort(port) {
  let output = "";
  try {
    output = execFileSync("lsof", ["-ti", `TCP:${port}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return;
  }

  for (const value of output.split(/\s+/).filter(Boolean)) {
    const pid = Number(value);
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

let control;
let projectWatcher;
const children = [];
async function startChildren() {
  freePort(controlPort);
  control = spawn(process.execPath, ["scripts/start-control-api.mjs"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, NODE_DISABLE_PROJECT_WATCHER: "1" },
  });
  children.push(control);
  await new Promise((resolve, reject) => {
  const onData = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text);
    if (text.includes("Node Control API listening")) {
      control.stdout.off("data", onData);
      resolve();
    }
  };
  control.stdout.on("data", onData);
  control.once("error", reject);
  control.once("exit", (code) => reject(new Error(`Node Control API exited before listening (${code ?? "signal"})`)));
  });
}

await startChildren();
projectWatcher = spawn(process.execPath, ["scripts/start-project-watcher.mjs"], {
  stdio: "inherit",
  env: process.env,
});
process.stdout.write(`Filesystem/index watcher started (pid ${projectWatcher.pid})\n`);

const sourceWatcher = chokidar.watch(["src/**/*.js", "src/**/*.mjs"], {
  ignoreInitial: true,
  usePolling: true,
  interval: 250,
  awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 }
});
let restartTimer;
let restarting = false;
sourceWatcher.on("all", (_event, path) => {
  process.stdout.write(`Source change detected: ${path}\n`);
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => restartChildren(), 200);
});

async function restartChildren() {
  if (restarting || stopping) return;
  restarting = true;
  control?.kill("SIGTERM");
  process.stdout.write("Control API restarting; filesystem/index watcher remains running\n");
  await new Promise((resolve) => setTimeout(resolve, 300));
  children.splice(0, children.length);
  try { await startChildren(); } finally { restarting = false; }
}

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  sourceWatcher.close().catch(() => {});
  projectWatcher?.kill("SIGTERM");
  for (const child of children) child.kill("SIGTERM");
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
for (const child of children) child.once("exit", (code, signal) => {
  if (!stopping && (code ?? 0) !== 0) {
    stop();
    process.exitCode = code ?? 1;
  }
});

// Finds foreground development service processes for controller shutdown.
import { readdirSync, readFileSync } from "node:fs";
import process from "node:process";

// Lists process IDs belonging to a development service.
export function findMatchingPids(name) {
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

// Checks whether a supervised service process still exists.
// eslint-disable-next-line no-silent-catch -- Liveness probe: ESRCH means not-alive, which is the answer.
export function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

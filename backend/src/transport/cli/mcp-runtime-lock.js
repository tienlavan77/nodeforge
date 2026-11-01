// Business purpose: prevents uninstall --purge from deleting an index used by a live external MCP session.
// Technical description: publishes a unique PID lock in the resolved runtime layout and removes only
// that lock when the session closes; stale locks remain recognizable by the existing PID scanner.
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { resolveRuntimePath } from "../../infrastructure/filesystem/runtime-layout.js";

// Business purpose: retains project runtime storage for as long as an MCP server is using its index.
// Technical description: atomically creates a session-specific lock containing the current PID and
// returns an idempotent release callback for runtime shutdown.
export function acquireMcpRuntimeLock(projectRoot) {
  const path = resolveRuntimePath(projectRoot, statePath(`wc/mcp-${process.pid}-${randomUUID()}.lock`));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: "wx" });
  return () => rmSync(path, { force: true });
}

// Business purpose: executes the `forge mcp install`, `forge mcp uninstall [--keep-index|--purge]`, `forge mcp status`, `forge mcp context-digest`, and `forge mcp pre-tool-hook` CLI commands so developers can manage Claude CLI and Codex CLI Forge MCP integration and Compact Context recovery safely per project.
// Technical description: coordinates non-destructive config merge/unmerge via `mcp-config-merge.js`, inspects index freshness in `.forge/runtime` / `.nf/`, verifies lock safety before `--purge` deletion, and outputs Compact Receipt Digests or PreToolUse native-tool redirection guidance.

import { createHash } from "node:crypto";
import { assertMcpConfigInstallSafe } from "./mcp-config-preflight.js";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { migrationPidAlive } from "../../infrastructure/filesystem/runtime-migration-files.js";
import { createDatabaseService } from "../../infrastructure/sqlite/database-service.js";
import { readSessionCompactLedger, reconcileLedgerWithDisk } from "./mcp-compact-ledger.js";
import {
  inspectCliConfigStatus,
  mergeClaudeMcpJson,
  mergeClaudeSettingsLocal,
  mergeCodexConfigToml,
  unmergeClaudeMcpJson,
  unmergeClaudeSettingsLocal,
  unmergeCodexConfigToml
} from "./mcp-config-merge.js";

// Business purpose: routes `forge mcp <subcommand>` CLI invocations (`install`, `uninstall`, `status`, `context-digest`, `pre-tool-hook`) and returns an exit code.
// Technical description: parses `--project`, `--keep-index`, and `--purge` flags and delegates to the corresponding lifecycle handler.
export async function runMcpLifecycleCli(args = [], { cwd = process.cwd(), stdin = null, stdout = process.stdout, stderr = process.stderr, hookPayload } = {}) {
  const action = args[1];
  if (!["install", "uninstall", "status", "context-digest", "pre-tool-hook"].includes(action)) {
    stderr.write("Usage: forge mcp <install|uninstall|status|context-digest> [--project <path>] [--keep-index|--purge]\n");
    return 1;
  }

  let projectRoot = cwd;
  let purge = false;
  let keepIndex = true;
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project") {
      if (i + 1 >= args.length || !String(args[i + 1]).trim()) {
        stderr.write("Missing value for --project.\n");
        return 1;
      }
      projectRoot = resolve(cwd, String(args[i + 1]).trim());
      i += 1;
    } else if (arg === "--purge") {
      purge = true;
      keepIndex = false;
    } else if (arg === "--keep-index") {
      keepIndex = true;
      purge = false;
    } else if (String(arg).startsWith("--")) {
      stderr.write(`Unknown option for forge mcp ${action}: ${arg}\n`);
      return 1;
    }
  }

  try {
    if (action === "install") {
      stdout.write(`${JSON.stringify(installMcpIntegration(projectRoot))}\n`);
      return 0;
    }
    if (action === "uninstall") {
      stdout.write(`${JSON.stringify(uninstallMcpIntegration(projectRoot, { purge, keepIndex }))}\n`);
      return 0;
    }
    if (action === "status") {
      stdout.write(`${JSON.stringify(await getMcpIntegrationStatus(projectRoot))}\n`);
      return 0;
    }
    if (action === "context-digest") {
      const reconciled = reconcileLedgerWithDisk(projectRoot, undefined, { refreshDiskStatus: true });
      stdout.write(`${reconciled.formatted_digest}\n`);
      return 0;
    }
    const { evaluatePreToolHookPayload, readHookStdinPayload } = await import("./mcp-pre-tool-hook.js");
    const payload = hookPayload !== undefined ? hookPayload : await readHookStdinPayload(stdin);
    stdout.write(`${JSON.stringify(evaluatePreToolHookPayload(payload))}\n`);
    return 0;
  } catch (error) {
    stderr.write(`${error.message}\n`);
    return 1;
  }
}

// Business purpose: installs NodeForge MCP server and compaction/discovery hooks into the target project for both Claude CLI and Codex CLI without overwriting existing user configurations.
// Technical description: invokes `mergeClaudeMcpJson`, `mergeClaudeSettingsLocal`, and `mergeCodexConfigToml` on the resolved project root.
export function installMcpIntegration(projectRoot, options = {}) {
  const root = resolve(projectRoot);
  assertMcpConfigInstallSafe(root);
  const codexMerged = mergeCodexConfigToml(root, options);
  return {
    status: "installed",
    project_root: root,
    claude: {
      mcp_json: mergeClaudeMcpJson(root, options),
      settings_local: mergeClaudeSettingsLocal(root, options)
    },
    codex: {
      config_toml: codexMerged,
      hooks_json: codexMerged.hooks_json
    }
  };
}

// Business purpose: safely removes NodeForge-managed MCP configuration entries and optionally purges `.nf/` / `.forge/runtime` when `--purge` is requested and no live process lock is active.
// Technical description: calls unmerge helpers for Claude and Codex, preserves index data by default (`--keep-index`), and checks `assertNoActiveProjectLocks` before deleting `.nf/` and `.forge/runtime` when `purge === true`.
export function uninstallMcpIntegration(projectRoot, { purge = false, keepIndex = !purge } = {}) {
  const root = resolve(projectRoot);
  if (purge) assertNoActiveProjectLocks(root);
  const claudeMcp = unmergeClaudeMcpJson(root);
  const claudeSettings = unmergeClaudeSettingsLocal(root);
  const codexConfig = unmergeCodexConfigToml(root);
  const purgedPaths = purge && !keepIndex ? purgeProjectRuntimeDirectories(root) : [];
  return {
    status: "uninstalled",
    project_root: root,
    keep_index: !purge,
    purged: Boolean(purge && !keepIndex),
    purged_paths: purgedPaths,
    claude: { mcp_json: claudeMcp, settings_local: claudeSettings },
    codex: { config_toml: codexConfig, hooks_json: codexConfig.hooks_json }
  };
}

// Business purpose: reports the complete installation status of Claude CLI, Codex CLI, SQLite code index freshness (`fresh`, `stale`, `uninitialized`), and Session Compact Ledger state for `forge mcp status`.
// Technical description: combines `inspectCliConfigStatus`, `inspectProjectIndexStatus`, and `reconcileLedgerWithDisk` into a unified status snapshot.
export async function getMcpIntegrationStatus(projectRoot) {
  const root = resolve(projectRoot);
  const cliStatus = inspectCliConfigStatus(root);
  const indexStatus = await inspectProjectIndexStatus(root);
  const ledger = readSessionCompactLedger(root);
  const reconciled = reconcileLedgerWithDisk(root, ledger, { refreshDiskStatus: true });
  return {
    project_root: root,
    claude: cliStatus.claude,
    codex: cliStatus.codex,
    claude_cli: cliStatus.claude,
    codex_cli: cliStatus.codex,
    index: indexStatus,
    compact_ledger: {
      initialized: ledger.exists,
      ledger_path: ledger.ledger_path,
      updated_at: ledger.updated_at,
      tracked_files_count: Object.keys(ledger.active_file_checksums ?? {}).length,
      inspected_steps_count: (ledger.inspected_steps ?? []).length,
      stale_files_count: reconciled.stale_paths.length,
      stale_paths: reconciled.stale_paths
    }
  };
}

// Business purpose: determines whether the project's SQLite code index is uninitialized, fresh, or stale relative to current files on disk.
// Technical description: checks if `index.db` exists inside `.forge/runtime/wc` or `.nf/`, queries indexed file rows via `createDatabaseService`, and compares stored SHA-256 digests against current disk contents.
async function inspectProjectIndexStatus(projectRoot) {
  const root = resolve(projectRoot);
  const wcDbPath = resolve(root, statePath("wc"), "index.db");
  const nfDbPath = resolve(root, ".nf", "index.db");
  const dbPath = existsSync(wcDbPath) ? wcDbPath : existsSync(nfDbPath) ? nfDbPath : null;
  if (!dbPath) return { status: "uninitialized", indexed_files: 0, database_path: null };
  let databaseService;
  try {
    databaseService = await createDatabaseService({ dataDir: root, runtimeDir: statePath("wc") });
    const rows = databaseService.read("SELECT path, sha256 FROM files");
    if (!rows.length) return { status: "uninitialized", indexed_files: 0, database_path: databaseService.databasePath };
    let staleCount = 0;
    for (const row of rows) {
      const fullPath = resolve(root, row.path);
      if (!existsSync(fullPath)) {
        staleCount += 1;
        continue;
      }
      const currentSha = `sha256:${createHash("sha256").update(readFileSync(fullPath, "utf8")).digest("hex")}`;
      const indexedSha = String(row.sha256 ?? "").startsWith("sha256:") ? row.sha256 : `sha256:${row.sha256}`;
      if (currentSha !== indexedSha) staleCount += 1;
    }
    return { status: staleCount === 0 ? "fresh" : "stale", indexed_files: rows.length, stale_files: staleCount, database_path: databaseService.databasePath };
  } catch (error) {
    return { status: "stale", indexed_files: 0, database_path: dbPath, error: error.message };
  } finally {
    await databaseService?.close?.();
  }
}

// Business purpose: prevents `forge mcp uninstall --purge` from deleting `.nf/` or `.forge/runtime` while a live watcher, control daemon, or operation lock is active in the project.
// Technical description: scans `.nf/` and `.forge/runtime` for `.lock` files and checks whether their recorded owner PID is alive via `migrationPidAlive`.
function assertNoActiveProjectLocks(projectRoot) {
  scanLocksRecursive(join(projectRoot, ".nf"));
  scanLocksRecursive(join(projectRoot, ".forge", "runtime"));
}

// Business purpose: recursively inspects a runtime directory for active `.lock` files owned by live OS processes.
// Technical description: reads each `.lock` file, extracts a numeric PID or JSON `{ pid, owner_pid }`, and throws an Error with code `PROJECT_LOCKED` if the process is alive.
function scanLocksRecursive(targetPath) {
  if (!existsSync(targetPath)) return;
  let stat;
  try { stat = statSync(targetPath); } catch (error) { throw new Error(`Cannot inspect runtime lock path: ${targetPath}`, { cause: error }); }
  if (stat.isDirectory()) {
    for (const entry of readdirSync(targetPath)) {
      if (entry !== "node_modules" && entry !== ".git") scanLocksRecursive(join(targetPath, entry));
    }
    return;
  }
  if (!targetPath.endsWith(".lock")) return;
  const content = readFileSync(targetPath, "utf8").trim();
  let pid = Number(content);
  if (content.startsWith("{")) {
    try {
      const parsed = JSON.parse(content);
      pid = Number(parsed.pid ?? parsed.owner_pid);
    } catch (error) { throw new Error(`Cannot parse runtime lock: ${targetPath}`, { cause: error }); }
  }
  let alive = false;
  try { alive = migrationPidAlive(pid); } catch (error) { throw new Error(`Cannot verify runtime lock owner: ${targetPath}`, { cause: error }); }
  if (alive) {
    throw Object.assign(new Error(`Cannot purge project runtime while an active process holds lock: ${targetPath}`), { code: "PROJECT_LOCKED" });
  }
}

// Business purpose: deletes the project's `.nf/` and `.forge/runtime` index/cache directories after lock safety has been verified during `--purge`.
// Technical description: removes `.nf` and `.forge/runtime` (and `.forge` if empty) using `rmSync`.
function purgeProjectRuntimeDirectories(projectRoot) {
  const purged = [];
  for (const rel of [".nf", ".forge/runtime"]) {
    const full = resolve(projectRoot, rel);
    if (existsSync(full)) {
      rmSync(full, { recursive: true, force: true });
      purged.push(full);
    }
  }
  const forgeDir = resolve(projectRoot, ".forge");
  if (existsSync(forgeDir)) {
    try {
      if (readdirSync(forgeDir).length === 0) rmSync(forgeDir, { recursive: true, force: true });
    } catch (error) { console.error(`Cannot clean empty Forge directory: ${error.message}`); }
  }
  return purged;
}

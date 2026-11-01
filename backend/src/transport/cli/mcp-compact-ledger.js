// Business purpose: maintains a durable per-project Session Compact Ledger in .nf/ so external Claude CLI and Codex CLI sessions using Forge MCP retain verified file SHA-256 checksums, line counts, and inspection receipts across context compaction without re-reading unchanged source files.
// Technical description: reads and atomically writes the compact ledger JSON inside the project's runtime storage, records discovery and mutation steps via updateActiveFileChecksums and recordDiscoveryCompactStep, reconciles tracked checksums against live files on disk, and formats the standardized Compact Receipt Digest.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  extractOwnerToolPathMeta,
  formatOwnerCompactReceiptDigest,
  recordDiscoveryCompactStep,
  updateActiveFileChecksums
} from "../../application/owner-context-compaction.js";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { resolveRuntimePath } from "../../infrastructure/filesystem/runtime-layout.js";

export const COMPACT_LEDGER_LOGICAL_PATH = statePath("nf/mcp-compact-ledger.json");

export const contextDigestDefinition = Object.freeze({
  name: "context_digest",
  description: "Return the current NodeForge Compact Receipt Digest with verified SHA-256 file checksums, disk freshness status (unchanged, modified_on_disk, deleted_on_disk), and recent inspected steps so unchanged files do not need to be re-read after context compaction.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      refresh_disk_status: {
        type: "boolean",
        description: "Verify each tracked file against current disk contents before building the digest (default: true)."
      }
    }
  }
});

// Business purpose: resolves the physical storage path for a project's MCP compact ledger while honoring legacy or grouped .nf/ runtime layouts.
// Technical description: maps the logical statePath("nf/mcp-compact-ledger.json") through resolveRuntimePath for the target projectRoot.
export function resolveCompactLedgerPath(projectRoot) {
  const root = resolve(projectRoot);
  try {
    return resolveRuntimePath(root, COMPACT_LEDGER_LOGICAL_PATH);
  } catch (error) {
    console.error(`Cannot resolve MCP ledger layout: ${error.message}`);
    return resolve(root, COMPACT_LEDGER_LOGICAL_PATH);
  }
}

// Business purpose: loads the persisted Session Compact Ledger for status inspection, digest generation, or incremental tool updates.
// Technical description: reads and parses the ledger JSON file if present, returning a normalized state object with active_file_checksums, inspected_steps, and changed_paths.
export function readSessionCompactLedger(projectRoot) {
  const ledgerPath = resolveCompactLedgerPath(projectRoot);
  if (!existsSync(ledgerPath)) {
    return {
      exists: false,
      ledger_path: ledgerPath,
      updated_at: null,
      active_file_checksums: {},
      inspected_steps: [],
      changed_paths: []
    };
  }
  try {
    const raw = JSON.parse(readFileSync(ledgerPath, "utf8"));
    return {
      exists: true,
      ledger_path: ledgerPath,
      updated_at: typeof raw?.updated_at === "string" ? raw.updated_at : null,
      active_file_checksums: raw?.active_file_checksums && typeof raw.active_file_checksums === "object" ? raw.active_file_checksums : {},
      inspected_steps: Array.isArray(raw?.inspected_steps) ? raw.inspected_steps : [],
      changed_paths: Array.isArray(raw?.changed_paths) ? raw.changed_paths : []
    };
  } catch (error) {
    console.error(`Cannot read MCP compact ledger: ${error.message}`);
    return {
      exists: true,
      ledger_path: ledgerPath,
      updated_at: null,
      active_file_checksums: {},
      inspected_steps: [],
      changed_paths: []
    };
  }
}

// Business purpose: persists updated file checksum receipts and inspection steps after each Forge MCP tool execution without storing raw source code or secrets.
// Technical description: atomically writes the sanitized ledger JSON to a temporary sibling file and renames it over the target ledger path.
export function writeSessionCompactLedger(projectRoot, state = {}) {
  const ledgerPath = resolveCompactLedgerPath(projectRoot);
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const payload = {
    version: 1,
    updated_at: new Date().toISOString(),
    active_file_checksums: sanitizeChecksums(state.active_file_checksums),
    inspected_steps: sanitizeSteps(state.inspected_steps),
    changed_paths: Array.isArray(state.changed_paths) ? [...new Set(state.changed_paths.filter((p) => typeof p === "string" && p))].slice(-32) : []
  };
  const tempPath = `${ledgerPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tempPath, ledgerPath);
  return { ...payload, exists: true, ledger_path: ledgerPath };
}

// Business purpose: strips any accidental raw content fields from checksum entries so the compact ledger only stores relative paths, SHA-256 digests, line counts, and status labels.
// Technical description: clones valid checksum map entries matching sha256 format and integer total_lines.
function sanitizeChecksums(map) {
  if (!map || typeof map !== "object") return {};
  const clean = {};
  for (const [path, entry] of Object.entries(map)) {
    if (!path || typeof path !== "string" || path.startsWith("/") || path.includes("..")) continue;
    if (!entry || typeof entry.sha256 !== "string") continue;
    clean[path] = {
      sha256: entry.sha256,
      ...(Number.isInteger(entry.total_lines) ? { total_lines: entry.total_lines } : {}),
      status: typeof entry.status === "string" ? entry.status : "read"
    };
  }
  return clean;
}

// Business purpose: bounds and sanitizes recorded discovery steps so the compact ledger remains small and free of raw source snippets.
// Technical description: retains at most 32 step records containing only tool, path, sha256, total_lines, location, and bounded search pattern.
function sanitizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(-32).map((step) => ({
    tool: String(step?.tool ?? step?.tool_name ?? "unknown"),
    ...(typeof step?.path === "string" && step.path ? { path: step.path } : {}),
    ...(typeof step?.sha256 === "string" && step.sha256 ? { sha256: step.sha256 } : {}),
    ...(Number.isInteger(step?.total_lines) ? { total_lines: step.total_lines } : {}),
    ...(typeof step?.location === "string" && step.location ? { location: step.location } : {})
  }));
}

// Business purpose: records a completed Forge MCP tool call into the project's Session Compact Ledger so external CLI agents keep an up-to-date receipt table.
// Technical description: delegates checksum extraction and step deduplication to recordDiscoveryCompactStep and updateActiveFileChecksums, then persists the updated state.
export function recordMcpLedgerToolCall(projectRoot, { toolName, input, result } = {}) {
  if (!toolName || toolName === "context_digest") return null;
  const current = readSessionCompactLedger(projectRoot);
  const state = {
    active_file_checksums: current.active_file_checksums,
    discovery_receipts: current.inspected_steps,
    owner_changed_paths: current.changed_paths
  };
  const discoveryUpdate = recordDiscoveryCompactStep(state, { toolName, input, result });
  const stepMeta = extractOwnerToolPathMeta(toolName, input);
  const isMutating = ["write_diff", "edit_diff", "delete_file", "move_file"].includes(toolName);
  const activeChecksums = discoveryUpdate?.active_file_checksums
    ?? updateActiveFileChecksums(current.active_file_checksums, {
      toolName,
      step: { tool_name: toolName, ...stepMeta },
      result
    });
  const inspectedSteps = discoveryUpdate?.discovery_receipts ?? current.inspected_steps;
  const targetPath = stepMeta.to_path ?? stepMeta.path ?? result?.path ?? result?.file_path ?? null;
  const changedPaths = isMutating && targetPath
    ? [...new Set([...current.changed_paths, targetPath])]
    : current.changed_paths;
  return writeSessionCompactLedger(projectRoot, {
    active_file_checksums: activeChecksums,
    inspected_steps: inspectedSteps,
    changed_paths: changedPaths
  });
}

// Business purpose: verifies tracked file checksums against current disk state so the agent knows immediately after compaction which files remain unchanged and which were modified or deleted on disk.
// Technical description: computes current SHA-256 and line count for each tracked path in active_file_checksums and annotates disk_status plus current_sha256 when diverged.
export function reconcileLedgerWithDisk(projectRoot, ledger = readSessionCompactLedger(projectRoot), { refreshDiskStatus = true } = {}) {
  const root = resolve(projectRoot);
  const reconciledChecksums = {};
  const stalePaths = [];
  for (const [relPath, entry] of Object.entries(ledger.active_file_checksums ?? {})) {
    if (!refreshDiskStatus) {
      reconciledChecksums[relPath] = { ...entry };
      continue;
    }
    const fullPath = resolve(root, relPath);
    if (!fullPath.startsWith(`${root}/`) || !existsSync(fullPath)) {
      reconciledChecksums[relPath] = {
        ...entry,
        status: "deleted_on_disk",
        disk_status: "deleted_on_disk"
      };
      stalePaths.push(relPath);
      continue;
    }
    try {
      const content = readFileSync(fullPath, "utf8");
      const currentSha = `sha256:${createHash("sha256").update(content).digest("hex")}`;
      const currentLines = content.split("\n").length;
      const unchanged = currentSha === entry.sha256;
      reconciledChecksums[relPath] = {
        ...entry,
        ...(unchanged ? {
          disk_status: "unchanged"
        } : {
          status: "modified_on_disk",
          disk_status: "modified_on_disk",
          recorded_sha256: entry.sha256,
          sha256: currentSha,
          total_lines: currentLines
        })
      };
      if (!unchanged) stalePaths.push(relPath);
    } catch (error) {
      console.error(`Cannot reconcile MCP checksum for ${relPath}: ${error.message}`);
      reconciledChecksums[relPath] = { ...entry, status: "stale", disk_status: "stale" };
      stalePaths.push(relPath);
    }
  }
  const selectedReceipts = (ledger.inspected_steps ?? []).map((item, idx) => ({
    sequence: idx + 1,
    tool_name: item.tool ?? "read_file",
    ...(item.path ? { path: item.path } : {}),
    ...(item.sha256 ? { read_checksum: item.sha256 } : {}),
    ...(Number.isInteger(item.total_lines) ? { total_lines: item.total_lines } : {})
  }));
  const rawDigestJson = formatOwnerCompactReceiptDigest({
    state: {
      active_file_checksums: reconciledChecksums,
      owner_changed_paths: ledger.changed_paths ?? []
    },
    selectedReceipts
  });
  return {
    ledger_path: ledger.ledger_path,
    updated_at: ledger.updated_at,
    active_file_checksums: reconciledChecksums,
    inspected_steps: ledger.inspected_steps ?? [],
    changed_paths: ledger.changed_paths ?? [],
    stale_paths: stalePaths,
    compact_receipt_digest: JSON.parse(rawDigestJson),
    formatted_digest: `Compact Receipt Digest (reuse verified unchanged sha256 checksums directly without re-reading unchanged files; re-read only paths marked modified_on_disk or deleted_on_disk):\n${rawDigestJson}`
  };
}

// Defines one versioned engineering tool contract while keeping authority in Node-issued execution policy.
import { readFileDefinition, writeDiffDefinition, editDiffDefinition, gitStatusDefinition, gitDiffDefinition } from "./index.js";
import { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "./agent-command-tools.js";
import { ownerSearchTreeDefinition } from "./owner-search-tree.js";
import { runCheckDefinition, commitChangesDefinition, pushCommitDefinition } from "./owner-engineer-tools.js";

export const ENGINEERING_CATALOG_VERSION = "forge-engineering-v1";
export const ENGINEERING_TOOL_NAMES = Object.freeze(["search_tree", "list_files", "search_text", "read_file", "read_lines", "write_diff", "edit_diff", "git_status", "git_diff", "run_check", "commit_changes", "push_commit"]);
export const ENGINEERING_ALIASES = Object.freeze({ rg_files: "list_files", rg_search: "search_text", sed_lines: "read_lines" });

// Returns provider-neutral descriptors without granting repository or ticket permissions.
export function engineeringToolDefinitions() {
  return [ownerSearchTreeDefinition,
    { ...rgFilesDefinition, name: "list_files", description: "List non-ignored project files with safe filters." },
    { ...rgSearchDefinition, name: "search_text", description: "Search project file contents with safe paths and filters." },
    readFileDefinition,
    { ...sedLinesDefinition, name: "read_lines", description: "Read a bounded project file window and checksum." },
    writeDiffDefinition, editDiffDefinition, gitStatusDefinition, gitDiffDefinition, runCheckDefinition,
    { ...commitChangesDefinition, description: "Commit only authorized files recorded in the execution-scoped Forge change ledger." },
    { ...pushCommitDefinition, description: "Push the exact execution-recorded commit only when a separate push grant is authorized." }
  ];
}

// Explains effective availability from issued capabilities and bound services, never from provider names.
export function engineeringToolReadiness({ capabilities = [], registry = {}, lockedReasons = {} } = {}) {
  const granted = new Set(capabilities);
  return { catalog_version: ENGINEERING_CATALOG_VERSION, tools: ENGINEERING_TOOL_NAMES.map((name) => {
    const reason = lockedReasons[name] ?? (!granted.has(name) ? "Capability is not granted by execution policy." : typeof registry[name]?.execute !== "function" ? "A compatible scoped service is unavailable." : null);
    return { name, state: reason ? "locked" : "available", reason };
  }) };
}

// Defines one versioned engineering tool contract while keeping authority in Node-issued execution policy.
import { queryReviewDefinition } from "./query-review-tool.js";
import { readFileDefinition, writeDiffDefinition, editDiffDefinition, gitStatusDefinition, gitDiffDefinition, reportDoneDefinition, respondToReviewDefinition } from "./index.js";
import { rgFilesDefinition, rgSearchDefinition, sedLinesDefinition } from "./agent-command-tools.js";
import { ownerSearchTreeDefinition } from "./owner-search-tree.js";
import { runCheckDefinition, commitChangesDefinition, pushCommitDefinition } from "./owner-engineer-tools.js";

import { verificationRunnerEnvironmentSchema } from "../modules/supervisor/verification-runner-environment.js";
import { ENGINEERING_CATALOG_VERSION, ENGINEERING_TOOL_NAMES } from "./engineering-tool-names.js";
export { ENGINEERING_CATALOG_VERSION, ENGINEERING_TOOL_NAMES, ENGINEERING_ALIASES, CODER_TOOL_NAMES } from "./engineering-tool-names.js";

// Adds ticket completion to the same engineering tools supplied to System Engineer.
export function coderToolDefinitions() {
  return [...engineeringToolDefinitions().map((tool) => tool.name === "run_check" ? { ...tool,
    description: tool.description + " Coder may request environment=filesystem_namespace for real filesystem fixtures; Node manages the runner.",
    input_schema: { ...tool.input_schema, properties: { ...tool.input_schema.properties, environment: verificationRunnerEnvironmentSchema } } } : tool),
    reportDoneDefinition, respondToReviewDefinition, queryReviewDefinition];
}

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

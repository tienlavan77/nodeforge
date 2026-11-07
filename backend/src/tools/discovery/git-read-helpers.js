// Business purpose: Provides shared input validation, path scoping, output bounds, status summarization, and tool definitions for the read-only Forge Git tools (`git_status`, `git_diff`, `git_log`, `git_show`, `git_blame`).
// Technical description: Extracts schema definitions and validation helpers from `git-read-tools.js` so both modules remain well under the 250-line budget.

import { ConfigurationError } from "../../shared/errors.js";
import { isAgentPathAllowed, isCoderBlockedPath } from "../governance/tool-authorization.js";

const MAX_OUTPUT_BYTES = 256_000;
const RELATIVE_PATH_PATTERN = "^(?!\\/)(?!.*(?:^|\\/)\\.\\.(?:\\/|$)).+$";

export const gitLogDefinition = Object.freeze({
  name: "git_log",
  description: "Read structured Git commit history through Node Git Service without shell access.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    properties: Object.freeze({
      limit: Object.freeze({ type: "integer", minimum: 1, maximum: 100, default: 20, description: "Maximum number of commits to return (1..100, default 20)." }),
      path: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN, description: "Optional project-relative file or directory path filter." }),
      revision: Object.freeze({ type: "string", minLength: 1, maxLength: 120, description: "Optional starting revision or range." }),
      grep: Object.freeze({ type: "string", minLength: 1, maxLength: 200, description: "Optional commit message substring or regex filter." })
    })
  })
});

export const gitShowDefinition = Object.freeze({
  name: "git_show",
  description: "Inspect a commit's metadata, changed files, and patch, or read a single file's historical content and sha256 at a revision without altering the working tree.",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["revision"],
    properties: Object.freeze({
      revision: Object.freeze({ type: "string", minLength: 1, maxLength: 120, description: "Commit SHA, branch, tag, or HEAD expression." }),
      path: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN, description: "Optional single project-relative file path to read at the given revision." }),
      paths: Object.freeze({
        type: "array",
        maxItems: 64,
        items: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN }),
        description: "Optional project-relative paths to filter commit diff output."
      }),
      stat_only: Object.freeze({ type: "boolean", description: "When true, returns --stat summary instead of full patch." })
    })
  })
});

export const gitBlameDefinition = Object.freeze({
  name: "git_blame",
  description: "Read line-by-line commit attribution for a project file within a bounded line window (max 200 lines).",
  input_schema: Object.freeze({
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: Object.freeze({
      path: Object.freeze({ type: "string", minLength: 1, pattern: RELATIVE_PATH_PATTERN, description: "Project-relative file path." }),
      start_line: Object.freeze({ type: "integer", minimum: 1, default: 1, description: "Inclusive 1-based start line." }),
      end_line: Object.freeze({ type: "integer", minimum: 1, description: "Inclusive 1-based end line (at most 200 lines from start_line)." })
    })
  })
});

// Business purpose: Validates that tool input is a non-null plain object.
// Technical description: Rejects null, primitives, and arrays with GIT_READ_INPUT_INVALID.
export function assertPlainObject(input, name) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw invalidInput(`${name} requires an object input.`);
  }
}

// Business purpose: Rejects unexpected fields on Git read tool inputs so callers adhere to the documented schema.
// Technical description: Checks Object.keys(input) against allowedKeys and throws GIT_READ_INPUT_INVALID on unknown keys.
export function assertAllowedKeys(input, allowedKeys, name) {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw invalidInput(`${name} does not accept '${key}'.`);
  }
}

// Business purpose: Validates and normalizes project-relative paths passed to Git read tools and enforces Coder read scope.
// Technical description: Rejects absolute paths, parent traversal (..), NUL bytes, and paths blocked by Coder policy.
export function normalizeInputPaths(paths, name, context) {
  if (paths === undefined) return undefined;
  if (!Array.isArray(paths) || paths.length > 64 || paths.some((p) => typeof p !== "string" || !p.trim())) {
    throw invalidInput(`${name} paths must be an array of 1..64 non-empty strings.`);
  }
  return paths.map((raw) => {
    const trimmed = raw.trim().replace(/^\.\//, "").replace(/\/$/, "");
    if (!trimmed || trimmed.startsWith("/") || trimmed.includes("\0") || trimmed.split("/").some((part) => part === "..")) {
      throw invalidInput(`${name} path must be a safe project-relative path: ${raw}`);
    }
    if (context?.agent_identity?.role === "coder" && (isCoderBlockedPath(trimmed, context) || !isAgentPathAllowed(trimmed, context, { operation: "read" }))) {
      const err = invalidInput(`${name} path is outside the permitted scope: ${trimmed}`);
      err.code = "TOOL_RESOURCE_FORBIDDEN";
      throw err;
    }
    return trimmed;
  });
}

// Business purpose: Combines caller-supplied paths with the execution context's allowed_file_paths and allowed_prefixes.
// Technical description: Filters out Coder-blocked paths and intersects explicit input paths with scoped paths when a scope exists.
export function resolveScopedPaths(requestedPaths, context, name) {
  const scoped = Array.isArray(context.allowed_file_paths ?? context.allowedFilePaths) || Array.isArray(context.allowed_prefixes ?? context.allowedPrefixes);
  const scope = [...new Set([...(context.allowed_file_paths ?? context.allowedFilePaths ?? []), ...(context.allowed_prefixes ?? context.allowedPrefixes ?? [])])]
    .filter((path) => !isCoderBlockedPath(path, context))
    .map((path) => path.replace(/\/$/, ""));
  if (scoped && !scope.length) throw invalidInput(`${name} has no approved paths.`);
  if (requestedPaths && requestedPaths.length) {
    if (!scoped) return requestedPaths;
    const filtered = requestedPaths.filter((reqPath) =>
      scope.some((allowed) => reqPath === allowed || reqPath.startsWith(`${allowed}/`) || allowed.startsWith(`${reqPath}/`))
    );
    if (!filtered.length) throw invalidInput(`${name} requested paths are outside the approved scope.`);
    return filtered;
  }
  return scoped ? scope : undefined;
}

// Business purpose: Enforces the 256KB output cap on Git read results to prevent context window exhaustion.
// Technical description: Throws GIT_READ_OUTPUT_TOO_LARGE when byte length exceeds MAX_OUTPUT_BYTES.
export function assertOutputSize(name, stdout) {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    const error = new ConfigurationError(`${name} output exceeds ${MAX_OUTPUT_BYTES} bytes.`);
    error.code = "GIT_READ_OUTPUT_TOO_LARGE";
    throw error;
  }
}

// Business purpose: Summarizes porcelain Git status with both enriched branch/count fields and legacy working-tree counters.
// Technical description: Parses porcelain lines and merges optional inspectStatus fields (branch, head_sha, ahead, behind, clean, counts).
export function summarizeGitStatus(stdout, rich = null) {
  const lines = stdout.split(/\r?\n/).filter(Boolean);
  const stagedCount = lines.filter((line) => line[0] !== " " && line[0] !== "?").length;
  const modifiedCount = lines.filter((line) => line[1] !== " " && line[1] !== "?").length;
  const untrackedCount = lines.filter((line) => line.startsWith("??")).length;
  const conflictedCount = lines.filter((line) => /^(UU|AA|DD|AU|UA|DU|UD)/.test(line)).length;
  return {
    branch: rich?.branch ?? null,
    head_sha: rich?.head_sha ?? null,
    ahead: rich?.ahead ?? 0,
    behind: rich?.behind ?? 0,
    has_conflicts: conflictedCount > 0,
    clean: lines.length === 0,
    modified_count: modifiedCount,
    untracked_count: untrackedCount,
    staged_count: stagedCount,
    working_tree: lines.length ? "dirty" : "clean",
    changed_files: lines.length,
    staged_files: stagedCount,
    unstaged_files: modifiedCount,
    untracked_files: untrackedCount,
    conflicted_files: conflictedCount
  };
}

// Business purpose: Gives invalid Git tool input a stable error code in logs and MCP responses.
// Technical description: Returns a ConfigurationError with code="GIT_READ_INPUT_INVALID".
export function invalidInput(message) {
  const error = new ConfigurationError(message);
  error.code = "GIT_READ_INPUT_INVALID";
  return error;
}

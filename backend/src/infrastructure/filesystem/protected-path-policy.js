// Defines secret and protected path patterns and checks whether a path is disallowed for read/write/index operations.
import { FORGE_STATE_DIR, STATE_DIR_PREFIX } from "./forge-paths.js";
import picomatch from "picomatch";
import { isCoderProjectPath } from "./coder-project-access.js";

// One policy is shared by runtime file operations and code indexing. Runtime
// storage is the only hidden project area intentionally exempted elsewhere.
export const SECRET_PATTERNS = Object.freeze([
  "**/.env",
  "**/.env.*",
  "**/*.key",
  "**/*.pem",
  "**/*.crt",
  "**/*.pfx",
  "**/*.keystore"
]);

export const PROTECTED_PATTERNS = Object.freeze([
  ...SECRET_PATTERNS,
  "**/.git/**",
  "**/.next/**",
  "**/.next.stale-*/**",
  "**/.forge/**"
]);

const matches = picomatch(PROTECTED_PATTERNS, { dot: true });

// Returns true if the normalized path matches secret/protected patterns, with runtime and indexing exceptions.
export function isProtectedPath(path, { operation = "read", forIndex = false, role } = {}) {
  if (typeof path !== "string" || !path) return true;
  if (role === "coder") return !isCoderProjectPath(path);
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (role === "system_engineer" && (normalized === ".forge" || normalized.startsWith(".forge/") || isProjectGitkeepPath(normalized))) return false;
  const runtimePath = normalized === FORGE_STATE_DIR || normalized.startsWith(STATE_DIR_PREFIX);
  if (runtimePath) return false;
  if (matches(normalized)) return true;
  if (forIndex && (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/"))) return true;
  return operation === "write" && normalized.split("/").some((part) => part.startsWith("."));
}

// Identifies directory placeholders that SE may remove during repository restructuring.
// Only an exact .gitkeep leaf beneath ordinary project directories qualifies; hidden
// parents, traversal, dependencies and generated trees do not inherit this exception.
export function isProjectGitkeepPath(path) {
  if (typeof path !== "string" || path.includes("\\") || path.includes("\0")) return false;
  const parts = path.split("/");
  return parts.pop() === ".gitkeep" && parts.every((part) => part && !part.startsWith(".")
    && !["node_modules", "vendor", "dist", "build", "coverage", "cache"].includes(part));
}

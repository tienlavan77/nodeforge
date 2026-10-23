// Defines secret and protected path patterns and checks whether a path is disallowed for read/write/index operations.
import { FORGE_STATE_DIR, STATE_DIR_PREFIX } from "./forge-paths.js";
import picomatch from "picomatch";

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
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (role === "system_engineer" && (normalized === ".forge" || normalized.startsWith(".forge/"))) return false;
  const runtimePath = normalized === FORGE_STATE_DIR || normalized.startsWith(STATE_DIR_PREFIX);
  if (runtimePath) return false;
  if (matches(normalized)) return true;
  if (forIndex && (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/"))) return true;
  return operation === "write" && normalized.split("/").some((part) => part.startsWith("."));
}

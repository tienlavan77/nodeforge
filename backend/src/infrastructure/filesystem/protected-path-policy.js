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

export function isProtectedPath(path, { operation = "read", forIndex = false } = {}) {
  if (typeof path !== "string" || !path) return true;
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  const runtimePath = normalized === ".forge/runtime" || normalized.startsWith(".forge/runtime/");
  if (runtimePath) return false;
  if (matches(normalized)) return true;
  if (forIndex && (normalized.includes("/node_modules/") || normalized.startsWith("node_modules/"))) return true;
  return operation === "write" && normalized.split("/").some((part) => part.startsWith("."));
}

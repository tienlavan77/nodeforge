// Utilities for detecting secret file paths and redacting sensitive text content.
import { basename, normalize } from "node:path";

export const DEFAULT_SECRET_PATTERNS = [
  "**/.env",
  "**/.env.*",
  "**/*.key",
  "**/*.pem",
  "**/*.crt",
  "**/*.pfx",
  "**/*.keystore"
];

const SECRET_BASENAME = /^(?:\.env(?:\..*)?|[^.].*\.(?:key|pem|crt|pfx|keystore))$/i;

// Creates a predicate that detects secret file paths against configured patterns.
export function createSecretPathMatcher(patterns = DEFAULT_SECRET_PATTERNS) {
  const configured = Array.isArray(patterns) ? patterns.filter((pattern) => typeof pattern === "string" && pattern.trim()) : [];
  return (path) => {
    if (typeof path !== "string" || !path.trim()) return false;
    const normalized = normalize(path).replaceAll("\\", "/").replace(/^\.\//, "");
    const name = basename(normalized);
    if (SECRET_BASENAME.test(name)) return true;
    return configured.some((pattern) => matchesPattern(normalized, pattern));
  };
}

// Tests a normalized path against a glob-style pattern.
function matchesPattern(path, pattern) {
  const normalized = pattern.replaceAll("\\", "/").replace(/^\.\//, "");
  const escaped = normalized.split("**").map((part) => part.split("*").map(escapeRegex).join("[^/]*")).join(".*");
  return new RegExp(`^${escaped}$`, "i").test(path) || new RegExp(`(?:^|/)${escaped}$`, "i").test(path);
}

// Escapes regex metacharacters in a pattern segment.
function escapeRegex(value) {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// Redacts API keys, tokens, and emails from free-form text.
export function redactSensitiveText(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|secret|password|credential)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.slice(0, match.search(/[:=]/) + 1)}[REDACTED]`)
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]");
}

// Produces one safe public error envelope for NodeForge HTTP responses.
const RETRYABLE_CODES = new Set(["timeout", "rate_limited", "service_unavailable", "temporarily_unavailable", "conflict", "network_error", "dispatch_failed", "retry_failed", "project_context_conflict"]);
const RETRYABLE_STATUSES = new Set([408, 409, 429, 502, 503, 504]);
const SCOPE_BY_CODE = Object.freeze({ validation_failed: "field", invalid_ticket: "field", context_missing: "field", verification_failed: "field", project_required: "field", ticket_creation_failed: "scoped", dispatch_failed: "scoped", retry_failed: "scoped" });

// Converts provider and application error codes to one stable wire token.
function token(value) { return String(value ?? "").trim().toLowerCase().replace(/[\s.-]+/g, "_"); }

// Removes credentials and infrastructure details from user-facing messages.
function safeMessage(raw, fallback) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  let value = raw.trim();
  if (/^[{[]/.test(value) || /\n\s*at\s+\S+|traceback|stack trace/i.test(value)) return fallback;
  value = value.split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 280);
  value = value.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]");
  value = value.replace(/(api[_-]?key|token|secret|password|authorization)[=:]\s*[^\s]+/gi, "$1=[redacted]");
  value = value.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
  return value || fallback;
}

// Normalizes canonical application errors at the HTTP egress boundary.
export function normalizeErrorContract({ error, statusCode, requestId, fallbackMessage } = {}) {
  const status = statusCode ?? error?.statusCode ?? null;
  const code = token(error?.code) || (status ? `http_${status}` : "unknown_error");
  const message = safeMessage(error?.message, safeMessage(fallbackMessage, "Yêu cầu không thành công."));
  const explicit = error?.retryable;
  const retryable = typeof explicit === "boolean" ? explicit : RETRYABLE_CODES.has(code) || RETRYABLE_STATUSES.has(status);
  const rawScope = token(error?.scope);
  const scope = ["field", "scoped", "global"].includes(rawScope) ? rawScope : SCOPE_BY_CODE[code] ?? (retryable ? "scoped" : "global");
  const id = String(requestId ?? error?.requestId ?? "").trim() || null;
  return { code, message, retryable, scope, requestId: id };
}

// Formats every HTTP error with only canonical public fields.
export function formatErrorBody(input = {}) {
  return { error: normalizeErrorContract(input) };
}

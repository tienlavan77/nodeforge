// Normalizes all UI errors to the canonical retry and display contract.
const RETRYABLE_CODES = new Set(["timeout", "rate_limited", "service_unavailable", "temporarily_unavailable", "conflict", "network_error", "dispatch_failed", "retry_failed", "project_context_conflict"]);
const NON_RETRYABLE_CODES = new Set(["input_invalid", "test_job_not_found", "test_job_forbidden", "configuration_error", "validation_error", "validation_failed"]);
const RETRYABLE_STATUSES = new Set([408, 409, 429, 502, 503, 504]);
const SCOPE_BY_CODE = Object.freeze({ validation_failed: "field", invalid_ticket: "field", context_missing: "field", verification_failed: "field", project_required: "field", ticket_creation_failed: "scoped", dispatch_failed: "scoped", retry_failed: "scoped" });

// Converts an error code to the same token used by the Control API.
function token(value) { return String(value ?? "").trim().toLowerCase().replace(/[\s.-]+/g, "_"); }

// Hides credentials and stack traces before an error reaches a component.
export function safeMessage(raw, fallback) {
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  let message = raw.trim();
  if (message.startsWith("{") || message.startsWith("[") || /\n\s*at\s+\S+|traceback|stack trace/i.test(message)) return fallback;
  message = message.split(/\r?\n/)[0].replace(/\s+/g, " ").slice(0, 280);
  message = message.replace(/https?:\/\/[^\s]+/gi, "[redacted-url]");
  message = message.replace(/(api[_-]?key|secret|token|password|authorization)[=:]\s*[^\s]+/gi, "$1=[redacted]");
  message = message.replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]");
  return message || fallback;
}

// Accepts string, Error, and canonical envelope inputs through one UI contract.
export function normalizeUiError(input, { requestId, fallback = "Request failed.", status } = {}) {
  const body = input && typeof input === "object" ? input.error && typeof input.error === "object" ? input.error : input : {};
  const code = token(body.code) || (status ? `http_${status}` : "unknown_error");
  const raw = typeof input === "string" ? input : body.message;
  const message = safeMessage(raw, safeMessage(fallback, "Request failed."));
  const explicit = body.retryable;
  const retryable = typeof explicit === "boolean" ? explicit : typeof input === "string" ? true : NON_RETRYABLE_CODES.has(code) ? false : RETRYABLE_CODES.has(code) || RETRYABLE_STATUSES.has(status);
  const rawScope = token(body.scope);
  const scope = ["field", "scoped", "global"].includes(rawScope) ? rawScope : SCOPE_BY_CODE[code] ?? (retryable ? "scoped" : "global");
  const id = String(requestId ?? body.requestId ?? "").trim() || null;
  return { code, message, retryable, scope, requestId: id };
}

// Exposes the canonical retry decision to UI controls.
export function isRetryableError(normalized) { return Boolean(normalized?.retryable); }

// Routes a normalized error to its global, scoped, or field display.
export function getErrorScope(normalized) { return ["field", "scoped"].includes(normalized?.scope) ? normalized.scope : "global"; }

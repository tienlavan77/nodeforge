// Keeps the public SE transcript identical in live delivery and saved conversation history.
// Redact credentials and private reasoning without treating token usage metrics or arbitrary
// tool source content as secrets, and without imposing output or collection-size limits.
const SECRET_FIELD = /(?:api[_-]?key|credential|secret|password|authorization|(?:^|[_-])(?:access[_-]?|auth[_-]?|refresh[_-]?)?token$)/i;
const PRIVATE_FIELD = /^(?:thinking|reasoning|encrypted_content|signature)$/i;

// Collects configured credential values so secrets embedded in tool text are also masked.
// Only the values are used for replacement; environment data is never added to an event.
export function systemEngineerEventSecrets() {
  return Object.entries(process.env).filter(([key, value]) => SECRET_FIELD.test(key) && value?.length >= 8).map(([, value]) => value);
}

// Removes sensitive values recursively while retaining every non-sensitive output byte.
// Storage and live events use this same policy to avoid divergent transcript payloads.
export function redactSystemEngineerEvent(value, secrets = systemEngineerEventSecrets()) {
  if (typeof value === "string") {
    let clean = value;
    for (const secret of secrets) if (secret) clean = clean.split(secret).join("[REDACTED]");
    return clean.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [REDACTED]")
      .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
      .replace(/((?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|authorization)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]");
  }
  if (Array.isArray(value)) return value.filter((item) => !["thinking", "redacted_thinking", "reasoning"].includes(item?.type)).map((item) => redactSystemEngineerEvent(item, secrets));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !PRIVATE_FIELD.test(key))
    .map(([key, item]) => [key, SECRET_FIELD.test(key) ? "[REDACTED]" : redactSystemEngineerEvent(item, secrets)]));
}

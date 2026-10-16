// Distinguishes rejected SDK requests from ambiguous provider timeouts before allowing Coder recovery.
const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "SERVICE_UNAVAILABLE"]);

// Adds retry evidence only for structured service rejection or a confirmed ended transient turn.
export function sdkFailureEvidence(failure, cause, { ended = false, aborted = false } = {}) {
  const status = cause?.status ?? cause?.statusCode;
  const code = cause?.code ?? cause?.cause?.code;
  if (!aborted && ([429, 503].includes(status) || ended && TRANSIENT_CODES.has(code))) {
    return Object.assign(failure, { provider_outcome: "failed", retry_safe: true,
      cause: { code: TRANSIENT_CODES.has(code) ? code : "SERVICE_UNAVAILABLE" } });
  }
  if (aborted || ["ETIMEDOUT", "ECONNRESET"].includes(code)) return Object.assign(failure, { provider_outcome: "unknown", retry_safe: false });
  return failure;
}

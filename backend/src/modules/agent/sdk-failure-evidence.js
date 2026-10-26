// Distinguishes rejected SDK requests from ambiguous provider timeouts before allowing Coder recovery.
const TRANSIENT_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "EAI_AGAIN", "SERVICE_UNAVAILABLE"]);

// Adds retry evidence only for structured service rejection or a confirmed ended transient turn.
export function sdkFailureEvidence(failure, cause, { ended = false, aborted = false } = {}) {
  const status = Number(cause?.status ?? cause?.statusCode);
  const code = cause?.code ?? cause?.cause?.code;
  if (Number.isInteger(status) && status >= 400 && status <= 599) failure.status = status;
  const modelUnavailable = temporaryModelFailure(cause, { ended });
  if (!aborted && !["unknown", "active"].includes(cause?.provider_outcome)
    && ([429, 503].includes(status) || modelUnavailable || ended && TRANSIENT_CODES.has(code))) {
    return Object.assign(failure, { provider_outcome: "failed", retry_safe: true,
      ...(modelUnavailable ? { status: 400 } : {}),
      cause: { code: TRANSIENT_CODES.has(code) ? code : "SERVICE_UNAVAILABLE" } });
  }
  if (aborted || ["ETIMEDOUT", "ECONNRESET"].includes(code)) return Object.assign(failure, { provider_outcome: "unknown", retry_safe: false });
  return failure;
}

/** Recognizes the gateway's temporary model outage even when it uses HTTP 400,
 * allowing checkpoint retry without treating malformed requests as outages.
 * Text-only status is accepted only from a confirmed failed SDK turn; this
 * helper consumes provider errors, never agent reports or ordinary responses. */
export function temporaryModelFailure(error, { ended = false } = {}) {
  if (!error || ["unknown", "active"].includes(error.provider_outcome)) return false;
  const status = Number(error.status ?? error.statusCode ?? error.response?.status);
  const message = typeof error.message === "string" ? error.message : "";
  const apiError = message.match(/\bAPI Error:\s*400\b[:\s-]*(.*)/i);
  if (status !== 400 && !(ended && !Number.isFinite(status) && apiError)) return false;
  return /(?:^|:\s*)(?:Lỗi model hiện tại,\s*thử lại sau(?:\s+hoặc liên hệ admin)?|(?:The )?model (?:is )?temporarily unavailable)(?:[.!\s(]|$)/iu.test(apiError?.[1] ?? message);
}

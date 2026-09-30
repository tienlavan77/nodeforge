// Applies the canonical Control API error contract at UI ingress.
import { getErrorScope, normalizeUiError } from "./ui-error.js";

// Converts an HTTP error response into the UI error contract.
export function normalizeBackendError({ body, status, fallbackError, requestId } = {}) {
  return normalizeUiError(body, { status, requestId, fallback: fallbackError ?? "Request failed." });
}

export { getErrorScope };

// Inline error display for field-level recoverable errors with retry.
"use client";
import { normalizeUiError } from "../lib/ui-error.js";

export function InlineError({ error, onRetry }) {
  if (!error) return null;
  const n = normalizeUiError(error);
  return (
    <span role="alert" className="inline-error">
      {n.message}
      {n.retryable && onRetry && <button type="button" onClick={onRetry}>Retry</button>}
    </span>
  );
}

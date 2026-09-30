// Global toast notifications for recoverable UI errors with retry action.
"use client";
import { normalizeUiError } from "../lib/ui-error.js";

export function GlobalToast({ error, onRetry, onDismiss }) {
  if (!error) return null;
  const normalized = normalizeUiError(error);
  return (
    <div role="alert" className="global-toast">
      <span>{normalized.message}</span>
      {normalized.requestId && <span className="toast-request-id">ID: {normalized.requestId}</span>}
      {normalized.retryable && onRetry && <button type="button" onClick={onRetry}>Retry</button>}
      {onDismiss && <button type="button" onClick={onDismiss} aria-label="Dismiss">×</button>}
    </div>
  );
}

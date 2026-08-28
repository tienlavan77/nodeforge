/**
 * Shared notification contract for Node-facing APIs.
 *
 * Keep user-facing messages here rather than composing error strings at call sites.
 */

const DEFINITIONS = Object.freeze({
  TICKET_NOT_FOUND: {
    status: 404,
    severity: 'error',
    message: 'The requested ticket was not found.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Check the ticket identifier and try again.',
  },
  TICKET_INVALID: {
    status: 400,
    severity: 'error',
    message: 'The ticket data is invalid.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Review the ticket data and try again.',
  },
  CONTEXT_NOT_FOUND: {
    status: 404,
    severity: 'error',
    message: 'The requested context was not found.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Check the context identifier and try again.',
  },
  INDEX_UNAVAILABLE: {
    status: 503,
    severity: 'error',
    message: 'The context index is temporarily unavailable.',
    retryable: true,
    audience: 'user',
    suggested_action: 'Wait a moment and try again.',
  },
  PATH_INVALID: {
    status: 400,
    severity: 'error',
    message: 'The requested path is invalid.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Use a valid workspace-relative path.',
  },
  PATH_NOT_FOUND: {
    status: 404,
    severity: 'error',
    message: 'The requested path was not found.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Check the path and try again.',
  },
  DISPATCH_UNAVAILABLE: {
    status: 503,
    severity: 'error',
    message: 'The request could not be dispatched.',
    retryable: true,
    audience: 'user',
    suggested_action: 'Wait a moment and try again.',
  },
  DISPATCH_REJECTED: {
    status: 409,
    severity: 'warning',
    message: 'The request was rejected before execution.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Review the request and try again.',
  },
  EXECUTION_FAILED: {
    status: 500,
    severity: 'error',
    message: 'Execution failed.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Review the request and try again.',
  },
  EXECUTION_TIMEOUT: {
    status: 504,
    severity: 'error',
    message: 'Execution timed out.',
    retryable: true,
    audience: 'user',
    suggested_action: 'Try again or reduce the scope of the request.',
  },
  EXECUTION_CANCELLED: {
    status: 409,
    severity: 'warning',
    message: 'Execution was cancelled.',
    retryable: true,
    audience: 'user',
    suggested_action: 'Start the execution again when ready.',
  },
  VERIFICATION_FAILED: {
    status: 422,
    severity: 'error',
    message: 'Verification failed.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Review the verification result and update the request.',
  },
  VERIFICATION_UNAVAILABLE: {
    status: 503,
    severity: 'error',
    message: 'Verification is temporarily unavailable.',
    retryable: true,
    audience: 'user',
    suggested_action: 'Wait a moment and try again.',
  },
  UNKNOWN_NOTIFICATION: {
    status: 500,
    severity: 'error',
    message: 'An unexpected error occurred.',
    retryable: false,
    audience: 'user',
    suggested_action: 'Try again. Contact support if the problem persists.',
  },
});

const FREEZE = (value) => Object.freeze(value);

export const NODE_NOTIFICATION_CATALOG = FREEZE(
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([code, definition]) => [
      code,
      FREEZE({ code, ...definition }),
    ]),
  ),
);

export const NODE_NOTIFICATION_CODES = FREEZE(Object.keys(NODE_NOTIFICATION_CATALOG));
export const UNKNOWN_NOTIFICATION_CODE = 'UNKNOWN_NOTIFICATION';

/**
 * Creates an immutable notification. Unknown codes intentionally use a safe,
 * non-sensitive fallback and retain the original code in details for logging.
 */
export function createNodeNotification(code, details) {
  const known = typeof code === 'string' && NODE_NOTIFICATION_CATALOG[code];
  const definition = known || NODE_NOTIFICATION_CATALOG[UNKNOWN_NOTIFICATION_CODE];
  const notification = {
    ...definition,
    ...(known ? {} : { details: { original_code: code } }),
    ...(details === undefined ? {} : { details }),
  };
  return FREEZE(notification);
}

export function getNodeNotification(code) {
  return NODE_NOTIFICATION_CATALOG[code] || NODE_NOTIFICATION_CATALOG[UNKNOWN_NOTIFICATION_CODE];
}

export const nodeNotificationCatalog = NODE_NOTIFICATION_CATALOG;
export const createNotification = createNodeNotification;

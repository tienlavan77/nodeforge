// Keeps temporary Reviewer transport failures resumable without inventing code findings or approval.
import { temporaryModelFailure } from "../../agent/sdk-failure-evidence.js";

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'SERVICE_UNAVAILABLE', 'BAD_GATEWAY', 'GATEWAY_TIMEOUT', 'REVIEW_TRANSPORT_FAILED']);

// Classifies observed infrastructure errors while preserving real approval denials and unknown outcomes.
export function reviewOperationalFailure(error) {
  if (error?.code === "REVIEWER_BUSY" && error.not_started === true && error.agent_wait?.agent_id)
    return { code: error.code, message: error.message, retryable: true, not_started: true, agent_wait: error.agent_wait };
  if (!error || /(?:DENIED|FORBIDDEN|REJECTED|OUTCOME_UNKNOWN|PROVIDER_UNKNOWN|RECONCILIATION)/.test(error.code ?? '')
    || /rejected due to unacceptable risk|approval denied/i.test(error.message ?? '')) return null;
  const status = Number(error.statusCode ?? error.status ?? error.response?.status);
  const message = String(error.message ?? '');
  const http = message.match(/\b(?:HTTP(?:\/[\d.]+)?(?:\s+status)?|status(?:\s+code)?|received(?:\s+HTTP)?|unexpected status)\s*[:=]?\s*(429|502|503|504)\b/i);
  const httpStatus = temporaryModelFailure(error, { ended: error.provider_outcome === "failed" }) ? 400
    : RETRYABLE_STATUS.has(status) ? status : http ? Number(http[1]) : null;
  if (!httpStatus && !RETRYABLE_CODES.has(error.code)) return null;
  return { code: error.code ?? (httpStatus ? `HTTP_${httpStatus}` : 'REVIEW_TRANSPORT_FAILED'), message,
    ...(httpStatus ? { status: httpStatus } : {}), retryable: true };
}

// Observes failed SDK tool results separately from Reviewer prose, including failures before Forge receives a call.
export function createReviewTransportObserver() {
  let failure = null;
  return { observe, assertAvailable };
  // Records only explicit transport failures, never inferring an outage from a finding's wording.
  function observe(event) {
    const item = event?.item;
    if (item?.type !== 'mcp_tool_call' || item.status !== 'failed') return;
    const error = typeof item.error === 'string' ? { message: item.error } : item.error;
    failure ??= reviewOperationalFailure(error);
  }
  // Rejects the invocation as incomplete before any returned verdict can become a repair finding.
  function assertAvailable() {
    if (failure) throw Object.assign(new Error(failure.message), failure);
  }
}

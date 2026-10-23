// Distinguishes actual approval decisions from tool validation, read-scope and provider availability failures.
const DENIAL_CODES = new Set(["APPROVAL_DENIED", "APPROVAL_REJECTED", "EXECUTION_APPROVAL_DENIED", "COMMIT_APPROVAL_REJECTED"]);

// Recognizes original server tool receipts without treating an agent's ACCESS_REQUIRED label as a denial.
export function isBlockerApprovalDenial(receipt) {
  if (receipt?.tool === "report_done" || receipt?.error?.code === "CODER_BLOCKED") return false;
  return DENIAL_CODES.has(receipt?.error?.code)
    || /^This action was rejected due to unacceptable risk\.(?:\s|$)/i.test(receipt?.error?.message ?? "");
}

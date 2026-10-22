// Distinguishes recorded technical failures from real access boundaries without changing historical blocker labels.
import { hasBlockerCommitAuthorization } from "./blocker-commit-authorization.js";
import { isBlockerApprovalDenial } from "./blocker-approval-denial.js";
import { createHash } from "node:crypto";
import { createBlockerFailureEvidence } from "./blocker-failure-evidence.js";

const TECHNICAL = new Set(["TICKET_BASELINE_CONFLICT", "TICKET_SOURCE_DRIFT", "TICKET_SOURCE_CHANGED", "TICKET_REF_CONFLICT",
  "TICKET_COMMIT_SCOPE", "TICKET_COMMIT_RECOVERY_CONFLICT", "FILE_CLAIM_CONFLICT", "CHECKSUM_MISMATCH", "VERIFY_ARTIFACT_MISMATCH",
  "VERIFY_RECOVERY_PENDING", "VERIFY_COMMAND_FAILED", "VERIFY_RECOVERY_FAILED", "READ_REPEATED",
  "TOOL_INPUT_INVALID", "SED_LINES_INPUT_INVALID", "READ_LINES_INPUT_INVALID", "REVIEW_TOOL_INPUT", "TOOL_SCOPE_INVALID", "CODER_REPORT_CONFLICT"]);

// Binds a classification to the original failure and execution so another ticket cannot reuse it.
function failureBinding(job) {
  const request = job.request;
  return createHash("sha256").update(JSON.stringify([job.id, job.reason_code, job.failure_at, request?.project_id,
    request?.task_id, request?.request_id, request?.correlation_id, request?.payload?.execution_id, request?.execution_context])).digest("hex");
}

// Requires complete server-read receipts before a stale access label can be treated as implementation recovery.
export function createBlockerFailureClassification({ readFailureEvidence = createBlockerFailureEvidence({ toolNames: null, requirePath: false }) } = {}) {
  return classify;

  // Preserves real denials, partial evidence and unknown failures as access prerequisites for Architecture.
  async function classify(job, workspace) {
    if (job.reason_code !== "ACCESS_REQUIRED") return null;
    const evidence = await readFailureEvidence(job, workspace.projectRoot ?? workspace.path);
    const receipts = (evidence.receipts ?? []).filter((entry) => !(entry.tool === "report_done" && entry.error?.code === "CODER_BLOCKED"));
    const technical = !job.execution_admission && evidence.status === "captured" && receipts.length > 0
      && receipts.every((entry) => TECHNICAL.has(entry.error?.code)
        && !isBlockerApprovalDenial(entry) && !/permission denied/i.test(entry.error?.message ?? ""));
    const ownerCommit = hasBlockerCommitAuthorization(job);
    return { binding: failureBinding(job), original_reason_code: job.reason_code,
      category: ownerCommit ? "owner_authorized_commit" : technical ? "technical_failure" : "access_or_unknown", evidence_status: evidence.status,
      requires_architecture_admission: !technical && !ownerCommit,
      receipts: receipts.map((entry) => ({ event_id: entry.event_id, tool: entry.tool, code: entry.error?.code })) };
  }
}

// Keeps access/security authority mandatory unless Node has freshly classified complete technical receipts.
export function requiresBlockerAdmission(job) {
  if (job.reason_code === "SECURITY_RISK") return true;
  if (job.reason_code !== "ACCESS_REQUIRED") return false;
  if (hasBlockerCommitAuthorization(job)) return false;
  const classification = job.ticket_progress?.failure_classification;
  return Boolean(job.execution_admission || classification?.binding !== failureBinding(job)
    || classification?.category !== "technical_failure" || classification.requires_architecture_admission !== false);
}

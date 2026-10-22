// Records an owner's scoped commit instruction so recovery can return to Coder without discarding a denied operation's audit.
import { admissionError } from "./blocker-execution-admission.js";

// Records only authenticated ticket-change commit consent against the exact retained denial, never push or unrelated mutations.
export async function recordBlockerCommitAuthorization({ admission, projectId, ticketId, authorization }) {
  if (!authorization || typeof authorization.actor !== "string" || !authorization.actor.trim()
    || !/^[a-f0-9]{64}$/.test(authorization.request_sha256 ?? "")
    || typeof authorization.reason !== "string" || !authorization.reason.trim() || authorization.reason.length > 8000) {
    throw admissionError("Explicit owner identity, denial request SHA and commit instruction are required.", "COMMIT_AUTHORIZATION_INPUT", 400);
  }
  const input = { projectId, ticketId, actor: authorization.actor };
  const { execution_admission: request } = await admission.access({ ...input, admission: { method: "GET" } });
  if (request.sha256 !== authorization.request_sha256) throw admissionError("Commit instruction refers to a stale denial request.", "EXECUTION_ADMISSION_IDENTITY_MISMATCH");
  if (!request.receipts?.length || request.receipts.some((receipt) => receipt.tool !== "commit_changes")) {
    throw admissionError("Commit consent cannot authorize a different denied operation.", "COMMIT_AUTHORIZATION_SCOPE", 409);
  }
  return admission.access({ ...input, admission: { method: "POST", review: {
    verdict: "allow", request_sha256: request.sha256, reason: authorization.reason,
    operation: "commit_changes", scope: "ticket_changes",
    guidance: "The owner explicitly requests Coder to resume this ticket checkpoint, implement remaining SL guidance, run focused checks, then commit only files changed by Coder in this ticket through commit_changes. Do not include unrelated files or push. Preserve tool approval, source, claim, verification and independent Reviewer gates."
  } } });
}

// Recognizes only a server-recorded owner instruction bound to this job and execution, not an agent's assertion of permission.
export function hasBlockerCommitAuthorization(job) {
  const request = job.execution_admission;
  const decision = request?.decision;
  return Boolean(request?.status === "owner_allowed" && decision?.verdict === "allow"
    && decision.operation === "commit_changes" && decision.scope === "ticket_changes"
    && decision.actor && decision.decision_id && decision.request_sha256 === request.sha256
    && request.job_id === job.id && request.project_id === job.request?.project_id
    && request.task_id === job.request?.task_id && request.execution_id === job.request?.payload?.execution_id
    && request.receipts?.length && request.receipts.every((receipt) => receipt.tool === "commit_changes"));
}

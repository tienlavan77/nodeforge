// Distinguishes recorded technical failures from real access boundaries without changing historical blocker labels.
import { hasBlockerCommitAuthorization } from "./blocker-commit-authorization.js";
import { isBlockerApprovalDenial } from "./blocker-approval-denial.js";
import { createHash } from "node:crypto";
import { createBlockerFailureEvidence } from "./blocker-failure-evidence.js";
import { readBlockerVerificationEvidence } from "./blocker-verification-evidence.js";

const TECHNICAL = new Set(["TICKET_BASELINE_CONFLICT", "TICKET_SOURCE_DRIFT", "TICKET_SOURCE_CHANGED", "TICKET_REF_CONFLICT",
  "TICKET_COMMIT_SCOPE", "TICKET_COMMIT_RECOVERY_CONFLICT", "FILE_CLAIM_CONFLICT", "CHECKSUM_MISMATCH", "VERIFY_ARTIFACT_MISMATCH",
  "VERIFY_RECOVERY_PENDING", "VERIFY_COMMAND_FAILED", "VERIFY_RECOVERY_FAILED", "VERIFY_BASELINE_UNAVAILABLE", "READ_REPEATED",
  "TOOL_INPUT_INVALID", "RG_SEARCH_INPUT_INVALID", "SED_LINES_INPUT_INVALID", "READ_LINES_INPUT_INVALID", "REVIEW_TOOL_INPUT", "TOOL_SCOPE_INVALID", "CODER_REPORT_CONFLICT"]);

// Binds a classification to the original failure and execution so another ticket cannot reuse it.
function failureBinding(job) {
  const request = job.request;
  return createHash("sha256").update(JSON.stringify([job.id, job.reason_code, job.failure_at, request?.project_id,
    request?.task_id, request?.request_id, request?.correlation_id, request?.payload?.execution_id, request?.execution_context])).digest("hex");
}

// Requires complete server-read receipts before a stale access label can be treated as implementation recovery.
export function createBlockerFailureClassification({ readFailureEvidence = createBlockerFailureEvidence({ toolNames: null, requirePath: false }),
  readVerificationEvidence = readBlockerVerificationEvidence } = {}) {
  return classify;

  // Preserves real denials, partial evidence and unknown failures as access prerequisites for Architecture.
  async function classify(job, workspace) {
    if (job.reason_code === "CONTRACT_DECISION_REQUIRED") {
      const context = await workspace.executionContexts?.load(job.request.task_id);
      if (!context || !Number.isFinite(Date.parse(job.failure_at)) || job.execution_admission || (job.request.ticket?.execution_policy?.contract_evidence ?? []).length
        || ["source_revision", "manifest_sha", "base_sha", "review_commit_sha"].some((key) => context[key] !== job.request.execution_context?.[key])) return null;
      const verification = await readVerificationEvidence({ job, workspace, context });
      const record = verification?.job;
      const diagnostic = verification?.diagnostic;
      if (verification?.status === "observed" && record?.status === "passed" && record.artifact_id
        && context.state === "verified" && context.verification_artifact_id === record.artifact_id) {
        return { binding: failureBinding(job), original_reason_code: job.reason_code, category: "technical_failure",
          effective_reason_code: "VERIFY_RECOVERY_READY", requires_architecture_admission: false,
          evidence_status: "captured", job_id: record.job_id, artifact_id: record.artifact_id };
      }
      if (verification?.status !== "observed" || record?.status !== "failed" || record.error?.code !== "VERIFY_COMMAND_FAILED"
        || diagnostic?.job_id !== record.job_id || diagnostic?.artifact_id !== record.artifact_id
        || !Number.isFinite(Date.parse(record.finished_at)) || Date.parse(record.finished_at) > Date.parse(job.failure_at)
        || !diagnostic.commands?.some((command) => command.blocking && Number.isInteger(command.exit_code) && command.exit_code > 0)) return null;
      const environment = diagnostic.commands.filter((command) => command.blocking && command.exit_code > 0).every((command) =>
        /ENOENT/.test(`${command.stdout_redacted ?? ""}\n${command.stderr_redacted ?? ""}`)
        && /mkdtemp/.test(`${command.stdout_redacted ?? ""}\n${command.stderr_redacted ?? ""}`));
      return { binding: failureBinding(job), original_reason_code: job.reason_code, category: "technical_failure",
        effective_reason_code: environment ? "VERIFY_ENVIRONMENT_INVALID" : "VERIFY_ATTRIBUTION_REQUIRED",
        requires_architecture_admission: false, evidence_status: "captured", job_id: record.job_id, artifact_id: record.artifact_id };
    }
    if (job.reason_code !== "ACCESS_REQUIRED") return null;
    const evidence = await readFailureEvidence(job, workspace.projectRoot ?? workspace.path);
    const receipts = (evidence.receipts ?? []).filter((entry) => !(entry.tool === "report_done" && entry.error?.code === "CODER_BLOCKED"));
    // A recorded server-side denial is a genuine access boundary; lacking or unrecognized evidence is not.
    const denial = receipts.some((entry) => entry.error?.code !== "CODER_BLOCKED" && (isBlockerApprovalDenial(entry)
      || /permission denied/i.test(entry.error?.message ?? "")
      || /(?:^|_)DENIED$/.test(entry.error?.code ?? "")));
    let technical = (!job.execution_admission || job.execution_admission.status === "retained_for_audit") && evidence.status === "captured"
      && receipts.length > 0 && receipts.every((entry) => TECHNICAL.has(entry.error?.code) && !isBlockerApprovalDenial(entry)
        && !/permission denied/i.test(entry.error?.message ?? ""));
    const failedChecks = !denial && !receipts.length && evidence.status === "captured"
      && (!job.execution_admission || job.execution_admission.status === "retained_for_audit")
      ? await classifyFocusedChecks(job, workspace, evidence) : [];
    if (failedChecks.length) technical = true;
    const recovered = technical && !denial ? await classifyPassedVerification(job, workspace) : null;
    const ownerCommit = hasBlockerCommitAuthorization(job);
    // An incomplete or unrecognized evidence set routes to technical reconciliation: re-inspect and capture the
    // real receipts. It never grants a technical handoff and never demands a policy/AM admission decision, so a
    // missing receipt cannot be laundered into either permission-to-resume or a fabricated access question.
    const evidenceIncomplete = !technical && !ownerCommit && !denial;
    return { binding: failureBinding(job), original_reason_code: job.reason_code,
      category: ownerCommit ? "owner_authorized_commit" : technical ? "technical_failure" : denial ? "access_or_unknown" : "evidence_incomplete",
      evidence_status: evidence.status,
      requires_architecture_admission: !technical && !ownerCommit && denial,
      requires_evidence_reconciliation: evidenceIncomplete,
      ...(failedChecks.length ? { effective_reason_code: "VERIFY_COMMAND_FAILED", check_ids: failedChecks } : {}),
      ...(recovered ? { effective_reason_code: "VERIFY_RECOVERY_READY", ...recovered } : {}),
      receipts: receipts.map((entry) => ({ event_id: entry.event_id, tool: entry.tool, code: entry.error?.code })) };
  }

  /** Recognizes completed Node verification for the exact retained ticket source.
   * Passing tests resolve a technical evidence gap only; unknown failures, partial
   * receipts and genuine access decisions never enter this path. */
  async function classifyPassedVerification(job, workspace) {
    if (!workspace.executionContexts?.load || !workspace.testService?.assertPassedArtifact) return null;
    const context = await workspace.executionContexts.load(job.request.task_id);
    const keys = ["source_revision", "manifest_sha", "base_sha", "review_commit_sha"];
    if (!context || context.project_id !== job.request.project_id || context.task_id !== job.request.task_id
      || context.state !== "verified" || !context.verification_artifact_id
      || keys.some(key => !context[key] || context[key] !== job.request.execution_context?.[key])) return null;
    const verification = await readVerificationEvidence({ job, workspace, context });
    const record = verification?.job;
    if (verification?.status !== "observed" || record?.status !== "passed" || !record.job_id
      || verification.source_revision !== context.source_revision || verification.commit_sha !== context.review_commit_sha
      || record.artifact_id !== context.verification_artifact_id) return null;
    let artifact;
    try { artifact = await workspace.testService.assertPassedArtifact(); }
    catch (error) { if (error.code === "VERIFY_ARTIFACT_MISMATCH") return null; throw error; }
    if (artifact?.status !== "passed" || artifact.pre_commit === true || artifact.task_id !== context.task_id
      || artifact.project_id !== context.project_id || artifact.artifact_id !== record.artifact_id
      || artifact.commit_sha !== context.review_commit_sha
      || artifact.baseline_recovery && artifact.baseline_recovery.execution_id !== job.request.payload?.execution_id
      || ["source_revision", "manifest_sha", "base_sha"].some(key => artifact[key] !== context[key])) return null;
    const current = await workspace.executionContexts.load(job.request.task_id);
    if ([...keys, "version", "task_id", "project_id", "state", "verification_artifact_id"].some(key => current?.[key] !== context[key])) return null;
    return { job_id: record.job_id, artifact_id: record.artifact_id };
  }

  // Recognizes a blocked report's explicit failed check references only after
  // Node independently loads receipts bound to this exact pre-commit source.
  // Agent prose and historical/foreign checks cannot resolve access denials.
  async function classifyFocusedChecks(job, workspace, evidence) {
    if (!workspace.executionContexts?.load || !Number.isFinite(Date.parse(job.failure_at))) return [];
    const references = new Set(evidence.receipts.filter(entry => entry.tool === "report_done" && entry.error?.code === "CODER_BLOCKED")
      .flatMap(entry => Array.isArray(entry.arguments?.evidence) ? entry.arguments.evidence : [])
      .filter(entry => entry.type === "run_check" && entry.result === "failed" && /^CHECK-[A-Za-z0-9-]+$/.test(entry.reference ?? ""))
      .map(entry => entry.reference));
    if (!references.size) return [];
    const context = await workspace.executionContexts.load(job.request.task_id);
    if (!context || context.project_id !== job.request.project_id || context.task_id !== job.request.task_id
      || ["source_revision", "manifest_sha", "base_sha", "review_commit_sha"].some(key => context[key] !== job.request.execution_context?.[key])) return [];
    const verification = await readVerificationEvidence({ job, workspace, context });
    const checks = verification?.checks ?? [];
    const matches = checks.filter(check => references.has(check.check_id) && check.status === "failed" && check.type === "test"
      && Number.isInteger(check.exit_code) && check.exit_code > 0 && check.source_revision === context.source_revision
      && check.commit_sha === context.review_commit_sha && (check.commit_sha || check.pre_commit === true)
      && Number.isFinite(Date.parse(check.completed_at)) && Date.parse(check.completed_at) <= Date.parse(job.failure_at)
      && /^sha256:[a-f0-9]{64}$/.test(check.receipt_sha256 ?? ""));
    return matches.length === references.size ? matches.map(check => check.check_id) : [];
  }
}

// Requires contract authority for genuine design blockers while source-bound verification failures stay in technical recovery.
export function requiresBlockerContract(job) {
  if (job.reason_code !== "CONTRACT_DECISION_REQUIRED") return false;
  const classification = job.ticket_progress?.failure_classification;
  return Boolean(job.execution_admission || (job.request.ticket?.execution_policy?.contract_evidence ?? []).length
    || classification?.binding !== failureBinding(job) || classification.category !== "technical_failure"
    || !["VERIFY_ENVIRONMENT_INVALID", "VERIFY_ATTRIBUTION_REQUIRED", "VERIFY_RECOVERY_READY"].includes(classification.effective_reason_code));
}

// Only a fresh Node classification can identify missing diagnostics; agent-authored claims cannot clear it.
export function requiresEvidenceReconciliation(job) {
  const classification = job.ticket_progress?.failure_classification;
  return job.reason_code === "ACCESS_REQUIRED" && classification?.binding === failureBinding(job)
    && classification.category === "evidence_incomplete" && classification.requires_evidence_reconciliation === true;
}

/** Removes only obsolete Node evidence-gap correction feedback after fresh
 * source-bound technical classification. Independent validator errors and actual
 * access decisions remain visible to the assigned coordinating agent. */
export function refreshBlockerFailureFeedback(job, classification) {
  const feedback = job.validation_feedback;
  if (classification?.binding !== failureBinding(job) || classification.category !== "technical_failure"
    || requiresBlockerAdmission({ ...job, ticket_progress: { ...job.ticket_progress, failure_classification: classification } })
    || !feedback?.some(entry => entry.reason === "failure_evidence_incomplete")) return false;
  job.validation_feedback = feedback.filter(entry => entry.reason !== "failure_evidence_incomplete");
  if (!job.validation_feedback.length) { delete job.validation_feedback; delete job.last_error; }
  return true;
}

// Keeps access/security authority mandatory for an evidenced denial, while incomplete diagnostic evidence
// remains technical reconciliation rather than being promoted to a policy decision.
export function requiresBlockerAdmission(job) {
  if (job.reason_code === "SECURITY_RISK") return true;
  if (job.reason_code !== "ACCESS_REQUIRED") return false;
  if (hasBlockerCommitAuthorization(job)) return false;
  const classification = job.ticket_progress?.failure_classification;
  const evidenceReconciliation = classification?.category === "evidence_incomplete"
    && classification.requires_evidence_reconciliation === true;
  return Boolean(job.execution_admission && job.execution_admission.status !== "retained_for_audit"
    || classification?.binding !== failureBinding(job)
    || classification?.category !== "technical_failure" && !evidenceReconciliation
    || classification.requires_architecture_admission === true);
}

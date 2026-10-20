// Prevents recovery agents from parking on verification records Node already supplied for this execution.
import { blockerValidationError } from "./blocker-validation.js";

// Returns correctable feedback for duplicate evidence waits while preserving genuine external prerequisites.
export function assertVerificationWait(value, job) {
  if (value.action !== "reconciliation_required") return;
  const verification = job.ticket_progress?.verification;
  if (verification?.status !== "observed") return;
  const conflicts = [];
  for (const [index, input] of (value.reconciliation?.waiting_for ?? []).entries()) {
    if (typeof input !== "string" && (input.owner !== "external" || input.operation === "execute")) continue;
    const question = typeof input === "string" ? input : input.question;
    const record = verification.job;
    let supplied = null;
    if (record?.job_id && question.includes(record.job_id) && ["passed", "failed"].includes(record.status)
      && /terminal|status|result|kết quả|trạng thái/i.test(question)) supplied = { job: record, diagnostic: verification.diagnostic };
    if (!supplied) {
      const check = verification.checks?.find((entry) => question.includes(entry.check_id));
      if (check && !/manifest|composition/i.test(question) && /output|diagnostic|result|status|kết quả|trạng thái/i.test(question)) supplied = { check: { check_id: check.check_id, status: check.status, exit_code: check.exit_code, evidence_ref: check.evidence_ref } };
      if (check && /archive|manifest|composition/i.test(question) && verification.source_composition?.files?.some((file) => question.includes(file.path)))
        supplied = { check: { check_id: check.check_id, status: check.status, evidence_ref: check.evidence_ref }, source_composition: verification.source_composition };
    }
    const integrated = verification.source_composition?.integrated_source;
    if (!supplied && value.reconciliation.kind === "dependency" && integrated?.status === "ready"
      && integrated.added_paths?.some((path) => question.includes(path)) && /revision|commit|integrat/i.test(question))
      supplied = { integrated_source: integrated };
    if (!supplied) continue;
    conflicts.push(blockerValidationError(`/reconciliation/waiting_for/${index}`, "verification_evidence_already_supplied",
      "Node already supplied this execution-bound verification evidence. Consume the actual terminal status and source diagnostic in ticket_progress.verification. Decide concrete in-scope recovery at SL or identify a distinct unavailable external prerequisite; do not wait for this record again. A failed check is not pending or a permission denial, and this feedback does not authorize mutations or waive tool gates.",
      { expected: supplied, received: input }).validation_errors[0]);
  }
  if (conflicts.length) throw Object.assign(blockerValidationError(conflicts[0].path, conflicts[0].reason, conflicts[0].message), { validation_errors: conflicts });
}

// Reasserts current runtime facts after historical discussion so stale pending messages cannot replace terminal evidence.
export function verificationDecisionPrompt(job) {
  const verification = job.ticket_progress?.verification;
  if (!verification || verification.status !== "observed") return "";
  return `CURRENT NODE VERIFICATION FACTS (supersede historical pending/status claims, never approval): ${JSON.stringify({
    job: verification.job, source_composition: verification.source_composition,
    failed_commands: verification.diagnostic?.commands?.filter((command) => command.exit_code !== 0 && command.blocking !== false),
    focused_checks: verification.checks?.map(({ check_id, status, exit_code, evidence_ref }) => ({ check_id, status, exit_code, evidence_ref })),
    failure_classification: job.ticket_progress.failure_classification
  })}\nSL must consume these current facts and choose the specific remaining recovery operation. Do not ask for a terminal result already present here. Ticket-owned files come from the recorded ticket commit. Other project files, including uncommitted dependencies, are captured separately by Node in the verification environment. Missing environment dependencies require repair within existing authority and fresh verification, not an unrelated dependency commit. Preserve existing commits and checkpoint work; do not recommit unchanged ticket files. A genuine dependency outside delegated scope needs its exact owner and missing input. Normal implementation and tests run after a validated SL handoff to Coder, never in read-only preparation.`;
}

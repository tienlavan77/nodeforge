// Assigns bounded technical reconciliation to Architecture within the existing ticket recovery pipeline.
import { sprintRecoveryWork, delegateSprintRecovery } from "./blocker-sprint-handoff.js";
import { validWaitingInput, assignWaitingWork } from "./blocker-waiting-work.js";
import { createHash } from "node:crypto";
import { blockerValidationError } from "./blocker-validation.js";

const KINDS = ["technical_design", "source_revision", "execution_admission", "dependency", "file_claim", "tooling"];
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 8000;
const list = (value) => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(text);

// Validates actionable investigation work and prevents an unresolved admission from authorizing Coder.
export function validateTechnicalReconciliation(value, job) {
  const work = value.reconciliation;
  if (work !== undefined) {
    validateReconciliationWork(value);
  }
  const result = value.technical_result;
  if (result === undefined && !((work || job?.technical_reconciliation || job?.coder_exchange) && value.action === "resolved")) return;
  if (!result || typeof result !== "object" || Array.isArray(result)
    || Object.keys(result).some((key) => !["findings", "implementation_steps", "verification_steps", "admission"].includes(key))
    || !list(result.findings) || !list(result.implementation_steps) || !list(result.verification_steps)
    || !result.admission || Object.keys(result.admission).some((key) => !["status", "rationale"].includes(key))
    || !["within_existing_permissions", "denied", "unresolved"].includes(result.admission.status) || !text(result.admission.rationale)) {
    throw blockerValidationError("/technical_result", "technical_result_incomplete", "Complete findings, implementation_steps, verification_steps and admission={status,rationale}; a request to investigate later is not a completed handoff.");
  }
  if (value.action === "resolved" && result.admission.status !== "within_existing_permissions") {
    throw blockerValidationError("/technical_result/admission", "admission_unresolved", "Denied or unresolved execution admission cannot resume Coder. Reconcile a permitted alternative or report the actual boundary.");
  }
}

// Identifies the exact malformed consultation field so SL can correct it without changing its decision.
function validateReconciliationWork(value) {
  const work = value.reconciliation;
  const actions = ["reconciliation_required", "architecture_required", "resolved"];
  if (!actions.includes(value.action)) throw blockerValidationError("/action", "reconciliation_action_mismatch",
    "Use reconciliation_required or architecture_required for unresolved work, or resolved with a completed technical_result and only post-handoff Coder execution.", { expected: actions, received: value.action });
  if (!work || typeof work !== "object" || Array.isArray(work)) throw blockerValidationError("/reconciliation", "object_required", "Provide a reconciliation object.");
  const unknown = Object.keys(work).find((key) => !["kind", "prerequisite", "completed_checks", "next_check", "waiting_for"].includes(key));
  if (unknown) throw blockerValidationError(`/reconciliation/${unknown}`, "additional_property", `Remove unsupported reconciliation property: ${unknown}.`);
  if (!KINDS.includes(work.kind)) throw blockerValidationError("/reconciliation/kind", "kind_invalid", "Choose a supported technical reconciliation kind.", { expected: KINDS, received: work.kind ?? null });
  for (const field of ["prerequisite", "next_check"]) {
    if (!text(work[field])) throw blockerValidationError(`/reconciliation/${field}`, "text_invalid", `Provide ${field} as nonempty text within 8000 characters.`);
  }
  if (!list(work.completed_checks)) throw blockerValidationError("/reconciliation/completed_checks", "checks_invalid", "Provide 1-16 nonempty completed checks, each within 8000 characters.");
  if (work.waiting_for !== undefined) {
    if (!Array.isArray(work.waiting_for) || !work.waiting_for.length || work.waiting_for.length > 16) throw blockerValidationError("/reconciliation/waiting_for", "waiting_list_invalid", "Provide 1-16 waiting inputs.");
    const index = work.waiting_for.findIndex((entry) => !validWaitingInput(entry));
    if (index !== -1) throw blockerValidationError(`/reconciliation/waiting_for/${index}`, "waiting_input_invalid", "Use a nonempty question or {owner:coder|architecture_manager|external,operation:inspect|execute,question}.");
    if (value.action === "resolved") {
      const pending = work.waiting_for.findIndex((entry) => entry?.owner !== "coder" || entry.operation !== "execute");
      if (pending !== -1) throw blockerValidationError(`/reconciliation/waiting_for/${pending}`, "resolved_prerequisite_pending",
        "Resolve all investigation, external and permission prerequisites before handoff. Only explicit {owner:coder,operation:execute,question} may describe normal implementation or verification after resume.");
    }
  }
}

// Requeues AM research durably, stopping repeated findings without a round quota without dispatching Coder.
export function scheduleTechnicalReconciliation(job, value, now) {
  if (value.execution_admission_request) {
    if (job.execution_admission?.sha256 !== value.execution_admission_request.sha256) job.execution_admission = value.execution_admission_request;
  }
  const work = value.reconciliation ?? { kind: "technical_design", prerequisite: value.summary,
    completed_checks: [value.guidance], next_check: value.guidance };
  const fingerprint = createHash("sha256").update(JSON.stringify({ kind: work.kind,
    role: job.stage, candidate: job.coder_exchange?.candidate?.sha256 ?? null,
    evidence: [...(value.evidence ?? [])].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) })).digest("hex");
  const previous = job.technical_reconciliation;
  const fingerprints = previous?.fingerprints ?? [];
  const repeated = fingerprints.includes(fingerprint);
  job.resolution = value;
  job.last_error = value.summary;
  if (assignWaitingWork(job, { ...value, reconciliation: work }, now)) return;
  if (work.waiting_for?.length || repeated) {
    job.status = "notification_pending";
    job.outcome_reason = work.waiting_for?.length ? "technical_reconciliation_waiting_for_evidence" : "technical_reconciliation_no_progress";
    job.technical_reconciliation = { ...previous, work, assigned_role: job.stage, max_rounds: null };
    job.history.push({ stage: job.stage, event: job.outcome_reason, rounds: previous?.round ?? 0, remaining_prerequisite: work.prerequisite, completed_at: now });
    return;
  }
  job.technical_reconciliation = { round: (previous?.round ?? 0) + 1, max_rounds: null,
    fingerprints: [...fingerprints, fingerprint], work, assigned_role: sprintRecoveryWork(job, work) ? "sprint_leader" : job.stage };
  if (job.stage !== "sprint_leader" && job.technical_reconciliation.assigned_role === "sprint_leader") delegateSprintRecovery(job, value, now);
  job.stage = job.technical_reconciliation.assigned_role;
  job.status = "pending";
  delete job.outcome_reason;
  job.history.push({ stage: job.stage, event: "technical_reconciliation_assigned", round: job.technical_reconciliation.round,
    prerequisite: work.prerequisite, next_check: work.next_check, completed_at: now });
}

// Gives Architecture an explicit completion contract rather than a request to park and delegate research.
export function technicalReconciliationPrompt(job) {
  return [
    "Owner admission review is an optional audit workflow, not a mandatory prerequisite to resuming SL. A retained denial must be respected: identify a materially safer permitted alternative or the actual unresolved boundary; do not wait for a hypothetical Node approval result or treat RUN as approval of the denied operation.",
    "Technical recovery stays inside this ticket. SL coordinates implementation with Coder; AM handles identified Architecture/contract decisions only; do not request a separate ticket or tell Node/SL/owner to perform technical analysis already delegated to you.",
    "For a genuine AM consultation SL returns architecture_required with the concrete question in guidance; an optional reconciliation object uses the same validated kind, prerequisite, completed_checks, next_check and waiting_for format. Node delivers that request to AM and returns its answer to SL without dispatching Coder. Use reconciliation_required for technical work that remains with the current coordinator. Neither action authorizes execution.",
    "For reconciliation_required include reconciliation={kind:technical_design|source_revision|execution_admission|dependency|file_claim|tooling,prerequisite,completed_checks:[concrete findings],next_check}. Node assigns implementation follow-ups to SL without a round-count limit while the original deadline remains valid. When required external evidence is unavailable, include waiting_for:[specific missing inputs and their owner/source]. Node parks the consultation instead of repeating discovery; explicit resume is required after supplying the input. Changes in wording or incidental source observations are not progress. Stop for unchanged evidence with no progress or a concrete execution boundary. Existing external claims, dependencies and approval denials remain constraints, not permissions.",
    "A completed technical handoff uses action=resolved plus technical_result={findings:[baseline/current comparisons and design conclusions],implementation_steps:[concrete file-level changes preserving criteria],verification_steps:[focused checks covering affected criteria],admission:{status:within_existing_permissions|denied|unresolved,rationale}}. Prefer omitting reconciliation after completion. If retained as completed investigation context, any waiting_for must exclusively use {owner:coder,operation:execute,question} for normal implementation/verification after handoff, never an outstanding investigation, external input or permission prerequisite. Source evidence and existing authority validation remain mandatory. Denied/unresolved admission cannot resolve the blocker. AM cannot override automatic approval review: an equivalent relocation is not a safer alternative, and owner approval cannot be inferred.",
    "Use git_diff for Node-selected baseline-to-current patches and read_file/read_lines for current source and whole-file hashes. Compare the ticket's declared contract evidence with the fixed-baseline patch and current source; explain drift without rewriting immutable bindings. Read further windows when needed. Failure evidence includes the original denial when available; if unavailable, identify that specific missing evidence instead of inventing an admission decision.",
    job.technical_reconciliation ? `ASSIGNED TECHNICAL WORK: ${JSON.stringify({ ...job.technical_reconciliation, max_rounds: null })}. Perform the next check now using read-only tools. Complete the design and revision comparison; do not merely repeat the previous guidance. If still blocked, report new inspected findings and the precise remaining prerequisite. Preserve the original execution and deadline.` : ""
  ].join("\n\n");
}

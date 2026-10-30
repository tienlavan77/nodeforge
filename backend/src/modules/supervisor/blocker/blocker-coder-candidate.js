// Validates read-only Coder candidate dossiers and binds AM technical review to the exact proposed changes.
import { createHash } from "node:crypto";
import { assertReviewerReadPath } from "../review/reviewer-forge-tools.js";
import { blockerValidationError } from "./blocker-validation.js";
import { coderRequestProgress } from "./blocker-ticket-progress.js";

// Bounds human-readable proposal fields before storing them in the recovery ledger.
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 24_000;
// Requires a small explicit set of review questions, constraints or verification steps.
const list = (value) => Array.isArray(value) && value.length > 0 && value.length <= 16 && value.every(text);
// Binds proposed changes and requests to an exact immutable content identity.
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Requires AM to state what information Coder must supply without granting mutation or execution approval.
export function validateCoderRequest(value, job) {
  const request = value.coder_request;
  if (job.stage !== "sprint_leader" || !request || Object.keys(request).some((key) => !["questions", "constraints", "criterion_ids"].includes(key))
    || !list(request.questions) || !list(request.constraints) || !text(value.guidance)) {
    throw blockerValidationError("/coder_request", "coder_request_invalid", "Only SL may request Coder. AM must return its design answer to SL using resolved or sprint_required, not coder_requested. SL must provide coder_request={questions:[specific missing information],constraints:[preserved boundaries]} and implementation guidance.");
  }
  if (job.coder_exchange?.candidate) validateCandidateReview(value.candidate_review, job, "changes_requested");
  coderRequestProgress(job, request);
}

// Checks source identities before either reviewing a candidate or handing its approved guidance to execution.
export async function assertCandidateSources(candidate, { fileService, projectRoot }) {
  for (const change of candidate.changes) {
    await assertReviewerReadPath(projectRoot, change.path);
    let content;
    try { content = await fileService.readFile({ path: change.path }); }
    catch (error) { if (error.code !== "ENOENT" || change.sha256 !== null) throw error; continue; }
    if (change.sha256 === null || createHash("sha256").update(content).digest("hex") !== change.sha256) {
      throw blockerValidationError("/candidate/changes", "candidate_source_stale", `Re-read ${change.path}; the candidate must match the current full-file checksum.`, { retryable: false });
    }
  }
}

// Accepts a proposed patch dossier only from the requested read-only Coder stage, never as a completed ticket report.
export async function validateCoderCandidate(value, { job, fileService, projectRoot }) {
  const candidate = value.candidate;
  if (job.stage === "coder" && job.coder_exchange?.request_id && value.action === "architecture_required" && text(value.guidance) && candidate === undefined) return value;
  if (job.stage !== "coder" || !job.coder_exchange?.request_id || value.action !== "candidate_prepared"
    || !candidate || Object.keys(candidate).some((key) => !["changes", "verification_steps"].includes(key))
    || !Array.isArray(candidate.changes) || !candidate.changes.length || candidate.changes.length > (job.request.ticket?.file_budget ?? 16)
    || !list(candidate.verification_steps) || Buffer.byteLength(JSON.stringify(candidate)) > 40_000) {
    throw blockerValidationError("/candidate", "candidate_invalid", "Requested Coder must return candidate_prepared with candidate={changes:[{path,sha256,patch,rationale}],verification_steps:[focused checks]}; max 40000 bytes.");
  }
  const budget = job.request.ticket?.file_budget;
  if (Number.isInteger(budget) && candidate.changes.length > budget) throw blockerValidationError("/candidate/changes", "candidate_budget", "Preserve the ticket's approved file budget.");
  const paths = new Set();
  for (const change of candidate.changes) {
    if (!change || Object.keys(change).some((key) => !["path", "sha256", "patch", "rationale"].includes(key)) || !text(change.path)
      || !(change.sha256 === null || /^[a-f0-9]{64}$/.test(change.sha256 ?? "")) || !text(change.patch) || !text(change.rationale) || paths.has(change.path)) {
      throw blockerValidationError("/candidate/changes", "candidate_change_invalid", "Supply distinct source paths, current bare sha256 (null for a new file), unified patch and rationale.");
    }
    const header = change.sha256 === null ? `--- /dev/null\n+++ b/${change.path}\n` : `--- a/${change.path}\n+++ b/${change.path}\n`;
    const deletion = change.sha256 !== null && change.patch.startsWith(`--- a/${change.path}\n+++ /dev/null\n`);
    if ((!change.patch.startsWith(header) && !deletion) || !change.patch.includes("\n@@ ")) {
      throw blockerValidationError("/candidate/changes/patch", "candidate_patch_invalid", "Each patch must contain unified hunks for exactly its declared source path.");
    }
    paths.add(change.path);
  }
  await assertCandidateSources(candidate, { fileService, projectRoot });
  return { ...value, candidate: { ...candidate, request_id: job.coder_exchange.request_id,
    sha256: digest({ request_id: job.coder_exchange.request_id, candidate }) } };
}

// Requires an explicit AM technical verdict for the exact Node-bound dossier, separate from execution-tool approval.
export function validateCandidateReview(review, job, verdict = "approved") {
  if (job.stage !== "sprint_leader" || !review || Object.keys(review).some((key) => !["candidate_sha256", "verdict", "comments"].includes(key))
    || review.candidate_sha256 !== job.coder_exchange?.candidate?.sha256 || review.verdict !== verdict || !list(review.comments)) {
    throw blockerValidationError("/candidate_review", "candidate_review_required", `The coordinating role must return candidate_review={candidate_sha256:the current Node-issued hash,verdict:${verdict},comments:[technical findings]}. This is not execution permission.`);
  }
}

// Persists the request/candidate exchange inside the original recovery job without dispatching normal Coder execution.
export function transitionCoderCandidate(job, value, now, sourceEvidence = null) {
  if (value.action === "coder_requested") {
    validateCoderRequest(value, job);
    const progress = coderRequestProgress(job, value.coder_request);
    const progress_key = sourceEvidence ? digest({ progress, source_evidence: sourceEvidence }) : progress;
    const request_id = digest({ job_id: job.id, execution: job.request.payload?.execution_id, source: job.request.execution_context,
      request: value.coder_request, guidance: value.guidance, previous_candidate: job.coder_exchange?.candidate?.sha256 ?? null });
    const repeatedProgress = progress_key && (progress_key === job.coder_exchange?.progress_key || job.coder_feedback_progress?.includes(progress_key));
    if (!job.coordination_feedback && job.coder_exchange?.coder_feedback && (repeatedProgress
      || !progress_key && JSON.stringify(job.coder_exchange.request) === JSON.stringify(value.coder_request) && job.coder_exchange.guidance === value.guidance)) {
      job.resolution = value; job.status = "pending"; job.stage = "sprint_leader";
      job.coordination_feedback = "No new implementation or verification evidence for this criterion scope. SL must choose resolved with a concrete permitted implementation handoff, ask one undecided AM question, or report a specific external input via reconciliation.waiting_for. Do not request the same read-only preparation again.";
      job.history.push({ stage: job.stage, event: "coder_request_no_progress", progress_key, completed_at: now });
      return true;
    }
    if (job.coordination_feedback && repeatedProgress) {
      job.status = "notification_pending"; job.outcome_reason = "technical_reconciliation_no_progress"; return true;
    }
    delete job.coordination_feedback;
    job.coder_exchange = { request_id, progress_key, request: value.coder_request, guidance: value.guidance, requested_at: now, review_role: "sprint_leader" };
    job.stage = "coder";
  } else if (value.action === "candidate_prepared") {
    job.coder_exchange.candidate = value.candidate;
    job.coder_exchange.prepared_at = now;
    job.stage = "sprint_leader";
  } else if (job.stage === "coder" && value.action === "architecture_required") {
    job.coder_exchange.coder_feedback = { summary: value.summary, guidance: value.guidance };
    job.coder_feedback_progress = [...new Set([...(job.coder_feedback_progress ?? []), job.coder_exchange.progress_key].filter(Boolean))];
    job.stage = "sprint_leader";
  } else return false;
  job.status = "pending";
  job.resolution = value;
  delete job.outcome_reason;
  job.history.push({ stage: job.stage, event: value.action, request_id: job.coder_exchange.request_id,
    candidate_sha256: value.candidate?.sha256 ?? null, completed_at: now });
  return true;
}

// Gives each side the requested dossier and original Coder progress while keeping all preparation read-only.
export function coderCandidatePrompt(job) {
  return [
    "Only SL coordinates Coder. Prefer resolving a cleared blocker with concrete implementation and verification steps so normal Coder resumes at its retained checkpoint. Use coder_requested only for specific missing information: coder_request={criterion_ids:[affected unverified AC IDs],questions:[specific missing information],constraints:[preserved boundaries]}. Node returns read-only preparation to SL; AM answers SL and cannot request Coder. Do not require a complete patch dossier for the whole ticket before execution.",
    "When an exact proposal is needed, Coder returns {action:candidate_prepared,summary,candidate:{changes:[{path,sha256,patch,rationale}],verification_steps:[focused checks]}} for the requested gap only. sha256 is current bare full-file hash, null for a new file. patch begins --- a/path and +++ b/path (use /dev/null for addition/deletion). For an explanation or missing input, return architecture_required with summary,guidance and optional criterion_updates; Node returns this information to SL, not AM. Do not repeat prior findings; answer only the requested missing information. No edits, claims, tests, commits, report_done, permission changes or production acceptance during preparation. Normal execution uses the original Coder checkpoint and existing gates.",
    "SL reviews the exact Node-issued candidate SHA within Sprint authority. AM supplies Architecture answers to SL without requesting or approving a Coder candidate. SL keeps implementation coordination; escalate to AM only for an identified Architecture/contract decision. For an acceptable design return resolved with candidate_review={candidate_sha256,verdict:approved,comments:[technical findings]} plus existing authority, source evidence and technical_result. For changes return coder_requested with candidate_review verdict=changes_requested and specific new questions/constraints. Technical approval is distinct from execution-tool approval, which still runs when Coder later implements. Do not demand an execution result for a proposal that has not run. A genuine prohibited operation still requires a permitted alternative or owner escalation; never relabel it as permitted.",
    job.coder_exchange ? `CODER EXCHANGE (proposal data, not permissions): ${JSON.stringify(job.coder_exchange)}` : "",
    job.coordination_feedback ? `SL DECISION REQUIRED: ${job.coordination_feedback}` : "",
    job.stage === "coder" ? "YOUR CURRENT ASSIGNMENT IS READ-ONLY CODER PREPARATION: answer the SL questions with candidate_prepared or architecture_required, not a resolved disposition or ticket completion report." : "",
    job.coder_checkpoint ? `ORIGINAL CODER CHECKPOINT (preserved, preparation does not complete or reset it): ${JSON.stringify(job.coder_checkpoint)}` : ""
  ].filter(Boolean).join("\n\n");
}

// Reuses retained recovery responses and stops unchanged validation failures without imposing an agent call quota.
import { createHash } from "node:crypto";
import { discoveryAssignment } from "./blocker-discovery-checkpoint.js";
import { agentDecisionEvidenceError } from "../../governance/agent-decision-schema.js";

// Reads a retained JSON disposition, including a single fenced response, without treating surrounding text as authority.
function retainedDisposition(text) {
  const trimmed = String(text).trim();
  const fences = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) => match[1].trim()).filter(Boolean);
  return JSON.parse(fences.length === 1 ? fences[0] : trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
}

/** Keeps schema corrections actionable without discarding a technical handoff
 * supplied in an earlier reply. Retained fields are agent-authored suggestions;
 * the next complete response still passes every authority and source validator. */
export function blockerCorrectionPrompt(job) {
  if (!job.validation_feedback?.length) return "";
  if (job.validation_feedback.every((entry) => entry.reason === "json_invalid"))
    return "JSON RESPONSE CORRECTION: The completed provider response is not valid JSON; no decision from it has been accepted. Return one shorter, complete JSON object with exactly kind, subject, payload and evidence. Close payload before its sibling evidence array and close the outer object. Preserve the assigned question and factual evidence; use current Node capability facts instead of historical capability claims. Do not repeat discovery or request a new Owner decision to fix JSON syntax.";
  const latest = job.disposition_attempts?.at(-1);
  let result = null;
  for (const attempt of (job.disposition_attempts ?? []).slice(-8).reverse()) {
    if (attempt.stage !== job.stage || attempt.assignment_id !== latest?.assignment_id) continue;
    try {
      const response = retainedDisposition(attempt.response?.text);
      const decision = response?.payload?.decision ?? response;
      if (decision?.action !== "resolved" || !decision.technical_result) continue;
      if (Buffer.byteLength(JSON.stringify(decision.technical_result)) > 8000) continue;
      result = decision.technical_result;
      break;
    } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  }
  return "COMPLETE RESPONSE CORRECTION: Fix the named fields and return the entire decision, preserving other completed fields. "
    + "For a resolved technical handoff include technical_result={findings:[completed facts],implementation_steps:[remaining Coder steps],verification_steps:[focused checks],admission:{status:within_existing_permissions|denied|unresolved,rationale:actual permission basis}}. "
    + "All three lists must be nonempty; resolved requires within_existing_permissions without overriding any tool denial. Updating evidence must not remove technical_result. "
    + "A schema failure is a response correction for the assigned role, not a new Owner question or tool denial. Consume recorded Owner inputs. "
    + evidenceCorrection(job)
    + (result ? `PREVIOUS AGENT-AUTHORED TECHNICAL RESULT (not validated authority; retain only facts that still apply): ${JSON.stringify(result)}` : "");
}

/** Returns exact read receipts to the same assignment for an evidence-format
 * correction. Node supplies observations only; the agent chooses the relevant
 * citations and the live validator still checks file access and current hashes. */
function evidenceCorrection(job) {
  if (!job.validation_feedback.some((entry) => /\/evidence(?:\/|$)/.test(entry.path))) return "";
  const checkpoint = job.discovery_checkpoints?.[job.stage];
  const references = new Map();
  if (checkpoint?.assignment_id === discoveryAssignment(job)) {
    for (const receipt of checkpoint.receipts ?? []) {
      if (!["read_file", "read_lines"].includes(receipt.tool)) continue;
      const path = receipt.input?.path, sha256 = receipt.source_sha256?.replace(/^sha256:/, "");
      if (typeof path !== "string" || path.length > 512 || path.includes("/blocker-context/")) continue;
      const reference = { path, sha256 };
      if (!agentDecisionEvidenceError([reference])) references.set(path, reference);
    }
  }
  return "SOURCE EVIDENCE CORRECTION: Look up your blocker_decision schema with the current action. "
    + "For resolved, sprint_required and owner_required supply 1-16 relevant inspected path/full-file SHA-256 pairs in payload.decision.evidence. "
    + "For architecture_required, reconciliation_required or coder_requested, evidence may be omitted or [] when unavailable; name the exact missing fact instead of fabricating proof. "
    + "The envelope evidence uses its separate transport schema. Do not confuse it with decision.evidence. Reuse applicable completed reads without restarting discovery; context delivery copies are not implementation evidence. "
    + `RETAINED READ REFERENCES (historical observations, not approval; select only relevant citations): ${JSON.stringify([...references.values()].slice(-16))}. `;
}

// Revalidates same-assignment evidence after a validator fix before making another provider request.
export async function salvagePersistedDisposition({ work, job, update, checkDisposition }) {
  // A reader fix may append progress after an old Reviewer invocation. Reuse
  // only its revalidated report bound to the unchanged nested AM assignment.
  const retainedReviewer = job.stage === "reviewer" && job.reviewer_evidence?.retained_response?.request_id === job.reviewer_evidence?.id
    ? job.reviewer_evidence?.retained_response?.sha256 : null;
  const retainedHandoff = job.stage === "sprint_leader" && job.delegation_evidence_review?.status === "answered" && job.delegation_evidence_review.handoff_reusable
    ? job.delegation_evidence_review.handoff?.response_sha256 : null;
  if (job.stage === "sprint_leader" && ["answered", "unresolved"].includes(job.delegation_evidence_review?.status) && !retainedHandoff) return null;
  const prior = (job.disposition_attempts ?? []).findLast((attempt) => attempt.stage === job.stage && (!attempt.assignment_id || attempt.assignment_id === discoveryAssignment(job)
    || retainedReviewer && attempt.response?.sha256 === retainedReviewer || retainedHandoff && attempt.response?.sha256 === retainedHandoff)
    && (attempt.status === "rejected" || retainedHandoff && attempt.response?.sha256 === retainedHandoff && attempt.status === "accepted") && attempt.response?.text);
  if (!prior?.response?.text) return null;
  let verified;
  try { verified = await checkDisposition(retainedDisposition(prior.response.text), job, { retained: true }); }
  catch (error) { return error && null; }
  const saved = await update(work, (current, ledger) => {
    ledger.calls = Math.max(0, ledger.calls - 1);
    const target = (current.disposition_attempts ?? []).findLast((attempt) => attempt.stage === current.stage && attempt.response?.sha256 === prior.response.sha256);
    if (target && target === current.disposition_attempts.at(-1)) { target.status = "received"; delete target.validation_errors; }
    else if (target) current.disposition_attempts.push({ stage: current.stage, assignment_id: discoveryAssignment(current), status: "received",
      response: target.response, reused_assignment_id: target.assignment_id, received_at: current.delegation_evidence_review?.answered_at ?? target.received_at });
    if (retainedHandoff) current.delegation_evidence_review.status = "consumed";
  });
  return saved ? verified : null;
}

/** Detects an unchanged correction repeated with no forward progress. A prior
 * fingerprint alone is not enough: the READ-WINDOW-SL sequence fixed one field
 * (technical_result), then failed another (a stale checksum), then regressed the
 * first. The intermediate reply that changed the failing-path set proves partial
 * progress, so SL receives another correction round instead of being parked. A
 * stop still fires when the failing-path set never narrowed in between (for
 * example value-only oscillation on the same field, or an unchanged reply on
 * unchanged source). */
export function repeatedDispositionCorrection(job, feedback) {
  const attempts = job.disposition_attempts ?? [];
  const attempt = attempts.at(-1);
  if (!attempt?.response?.text) return false;
  let response;
  try { response = retainedDisposition(attempt.response.text); }
  catch (error) { response = { unparsed: attempt.response.sha256, error: error.message }; }
  const errors = feedback.map(({ path, reason, received }) => {
    const parts = (path ?? "").split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    const value = parts.reduce((node, part) => node?.[part], response);
    return { path, reason, value: response.unparsed && path === "/" ? response.unparsed : received ?? value ?? null };
  }).sort((a, b) => String(a.path).localeCompare(String(b.path)));
  const paths = errors.map(({ path }) => path).sort();
  const fingerprint = createHash("sha256").update(JSON.stringify({ assignment: attempt.assignment_id ?? discoveryAssignment(job),
    stage: job.stage, source: job.ticket_progress?.evidence_sha256 ?? null, errors })).digest("hex");
  const priorIndex = attempts.slice(0, -1).map((entry) => entry.correction_fingerprint).lastIndexOf(fingerprint);
  const progressed = priorIndex !== -1 && attempts.slice(priorIndex + 1, -1)
    .some((entry) => entry.correction_paths && JSON.stringify(entry.correction_paths) !== JSON.stringify(paths));
  // Repeating an error transition is a cycle, not further partial progress.
  // Fingerprints already bind assignment, stage and source, so unrelated work
  // cannot consume this opportunity. Persist the transition across restarts.
  const previous = attempts.at(-2);
  const transition = previous?.correction_fingerprint
    ? createHash("sha256").update(JSON.stringify([previous.correction_fingerprint, fingerprint])).digest("hex") : null;
  const cycle = transition !== null && attempts.slice(0, -1).some((entry) => entry.correction_transition === transition);
  const repeated = priorIndex !== -1 && !progressed || cycle;
  attempt.correction_fingerprint = fingerprint;
  attempt.correction_paths = paths;
  if (transition) attempt.correction_transition = transition;
  return repeated;
}

// Assigns missing blocker evidence to an existing recovery role instead of leaving an unowned wait.
import { createHash } from "node:crypto";
import { transitionCoderCandidate } from "./blocker-coder-candidate.js";

const OWNERS = ["coder", "architecture_manager", "external"];
const text = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 8000;

// Validates explicit evidence ownership while retaining legacy string inputs from parked checkpoints.
export function validWaitingInput(input) {
  return text(input) || Boolean(input && typeof input === "object" && !Array.isArray(input)
    && Object.keys(input).every((key) => ["owner", "question", "operation"].includes(key)) && OWNERS.includes(input.owner) && text(input.question)
    && (input.operation === undefined || ["inspect", "execute"].includes(input.operation)));
}

// Resolves legacy source comparisons to Coder and leaves actual permission/dependency decisions external.
export function waitingAssignments(work) {
  const assignments = (work?.waiting_for ?? []).map((input) => typeof input === "string"
    ? { owner: work.kind === "source_revision" ? "coder" : work.kind === "technical_design" ? "architecture_manager" : "external", question: input }
    : { ...input });
  const external = assignments.some((entry) => entry.owner === "external");
  return assignments.map((entry) => ({ ...entry, operation: entry.operation
    ?? (entry.owner === "coder" && external ? "unspecified" : "inspect") }));
}

// Ignores conversation/progress wording and incidental supporting files when binding a source investigation.
function evidenceIdentity(job, owner, kind, evidence, nodeSource = null) {
  const declared = (job.request.ticket.execution_policy?.contract_evidence ?? []).map((entry) => entry.path);
  const source = evidence.filter((entry) => !declared.length || declared.includes(entry.path));
  return createHash("sha256").update(JSON.stringify({ execution: job.request.payload?.execution_id, owner, kind,
    node_source: nodeSource, evidence: source.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)) })).digest("hex");
}

// Distinguishes newly supplied Node journal facts without treating incidental file writes as progress.
function sourceIdentity(job, evidence) {
  const snapshot = job.ticket_progress?.source_reconciliation;
  if (!snapshot || snapshot.status !== "observed") return null;
  const paths = (job.request.ticket.execution_policy?.contract_evidence ?? evidence).map((entry) => entry.path);
  return createHash("sha256").update(JSON.stringify({ parent: snapshot.parent_sha,
    files: snapshot.files.filter((entry) => paths.includes(entry.path)) })).digest("hex");
}

// Routes one source-bound evidence request through SL without granting edits, provenance or denied permissions.
export function assignWaitingWork(job, value, now) {
  const work = value.reconciliation;
  if (!work?.waiting_for?.length) return false;
  const assignments = waitingAssignments(work);
  job.waiting_assignments = assignments;
  const evidence = [...(value.evidence ?? [])].map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  const available = assignments.filter((entry) => entry.operation === "inspect");
  const owner = available.some((entry) => entry.owner === "coder") ? "coder"
    : available.some((entry) => entry.owner === "architecture_manager") ? "architecture_manager" : "external";
  if (owner === "external") return false;
  const nodeSource = sourceIdentity(job, evidence);
  const fingerprint = evidenceIdentity(job, owner, work.kind, evidence, nodeSource);
  if (job.waiting_work_history?.some((entry) => entry.fingerprint === fingerprint
    || evidenceIdentity(job, entry.owner, entry.kind, entry.evidence ?? [], entry.node_source ?? null) === fingerprint)) {
    job.coordination_feedback = "The assigned evidence request already ran for this source/progress. Consume its retained response and decide a concrete permitted next step, identify the actual external source/permission boundary, or report no progress. Rewording the request cannot relaunch the same preparation.";
    return false;
  }
  // Architecture answers return to SL first; only SL delegates Coder preparation.
  if (job.stage !== "sprint_leader") {
    job.stage = "sprint_leader";
    job.status = "pending";
    job.resolution = value;
    job.history.push({ stage: "sprint_leader", event: "waiting_evidence_returned_to_sprint", assignments, completed_at: now });
    return true;
  }
  const questions = available.filter((entry) => entry.owner === owner).map((entry) => entry.question);
  job.waiting_work_history ??= [];
  const record = { fingerprint, owner, kind: work.kind, evidence, node_source: nodeSource, assignments, assigned_at: now, status: "assigned" };
  if (owner === "coder") {
    const ids = job.ticket_progress?.pending_criterion_ids
      ?? (job.request.ticket.acceptance_criteria ?? []).map((_criterion, index) => `AC-${index + 1}`);
    if (!ids.length || job.coder_exchange?.candidate) return false;
    const request = { action: "coder_requested", summary: "SL's missing evidence assigned to read-only Coder preparation.",
      guidance: `Answer only the missing source/provenance/compatibility questions from the retained checkpoint. Report what cannot be proven and who must supply it. Return architecture_required with findings to SL; no full patch dossier is required. Node source binding: ${JSON.stringify(evidence)}`,
      coder_request: { criterion_ids: ids, questions, constraints: [
        "Read-only evidence collection. Preserve existing work, claims, immutable baseline and execution identity; do not edit, test, commit, rebind or modify the source journal.",
        "A source comparison is not proof of authorship, permission or compatibility acceptance. Cite inspected hashes and distinguish known facts from missing provenance.",
        "Preserve original operation denials. Do not retry, relocate or indirectly execute a denied mutation; describe a materially safer permitted alternative only when supported."
      ] } };
    if (!transitionCoderCandidate(job, request, now, fingerprint)) return false;
    if (job.stage !== "coder") return false;
    record.request_id = job.coder_exchange.request_id;
    job.coder_exchange.waiting_work_fingerprint = fingerprint;
  } else {
    job.stage = "architecture_manager";
    job.status = "pending";
    job.resolution = { ...value, action: "architecture_required", guidance: questions.join("\n\n") };
  }
  job.waiting_work_history.push(record);
  job.history.push({ stage: job.stage, event: "waiting_evidence_assigned", fingerprint, owner, completed_at: now });
  delete job.outcome_reason;
  return true;
}

// Saves the requested findings for SL without treating a provider response as verified provenance or approval.
export function completeWaitingWork(job, value, now) {
  const request = job.waiting_work_history?.findLast((entry) => entry.status === "assigned" && entry.owner === job.stage
    && (job.stage !== "coder" || entry.request_id === job.coder_exchange?.request_id));
  if (!request) return;
  request.status = "answered";
  request.response = value;
  request.answered_at = now;
}

// Tells each recovery role exactly who supplies missing input and what their response can authorize.
export function waitingWorkPrompt(job) {
  return [
    "For waiting_for prefer [{owner:coder|architecture_manager|external,operation:inspect|execute,question:specific missing input}]. Only inspect work can run in read-only preparation. Mark future implementation/tests/verification as execute: they cannot run in preparation, and must wait for a permitted normal Coder handoff. With mixed external prerequisites, an unspecified Coder operation is deferred until SL classifies it explicitly. Assign source comparison/provenance investigation to coder, a genuinely undecided Architecture question to architecture_manager, and actual permission/ownership/operator facts to external. Mixed prerequisites must be separated. Never claim a comparison fixes the source journal or overrides a tool denial.",
    "SL must consume returned Coder findings and decide resolved with permitted implementation steps, ask one identified AM question, or identify the precise external blocker. Coder preparation answers only the assigned questions with architecture_required and inspected evidence; no writes or full-ticket dossier.",
    job.waiting_assignments ? `NODE EVIDENCE OWNERS: ${JSON.stringify(job.waiting_assignments)}` : "",
    job.waiting_work_history?.length ? `RETAINED EVIDENCE ASSIGNMENTS (findings, not authorization): ${JSON.stringify(job.waiting_work_history)}` : ""
  ].filter(Boolean).join("\n\n");
}

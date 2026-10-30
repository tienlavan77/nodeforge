// Reconciles ticket-owned changes and immutable verification into criterion progress for recovery decisions.
import { inspectBlockerReviewAccess } from "./blocker-review-access.js";
import { createHash } from "node:crypto";
import { completeNodeReportEvidence } from "../../../tools/reporting/node-report-evidence.js";
import { blockerValidationError } from "./blocker-validation.js";
import { readBlockerVerificationEvidence } from "./blocker-verification-evidence.js";
import { createTicketContractSource } from "../ticket/ticket-contract-source.js";
import { blockerDependencyProgress } from "./blocker-dependency-progress.js";
import { inspectReviewResponseReadiness } from "../review/review-response-readiness.js";
import { ticketSourceChanges } from "../ticket/ticket-source-observation.js";
import { blockerReviewStatus } from "./blocker-review-status.js";
import { blockerRuntimeCapabilities } from "./blocker-runtime-capabilities.js";

// Identifies evidence rather than agent wording so repeated requests cannot masquerade as new work.
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// Builds a conservative progress snapshot; inspected or merely changed files never prove acceptance.
export async function buildBlockerTicketProgress({ job, checkpoint, workspace, reviewCheckpoint, sprintRegistry, ticketStatusStore }) {
  const ticket = job.request.ticket;
  const context = await workspace.executionContexts.load(job.request.task_id);
  const dependencies = blockerDependencyProgress({ request: job.request, job, sprintRegistry, ticketStatusStore });
  const review_access = await inspectBlockerReviewAccess({ job, workspace, checkpoint, reviewCheckpoint, context });
  const retained_review_source = await workspace.inspectFindingReviewSource?.() ?? null;
  const review_response_delivery = await inspectReviewResponseReadiness(workspace, job.request.task_id);
  const reviewExchange = await workspace.reviewFindings?.load?.();
  const review_findings = (reviewExchange?.findings ?? []).map((entry) => {
    const finding = { ...entry }; delete finding.history; delete finding.refinements;
    return { ...finding, original: entry.history?.[0] ?? null,
      latest_adjudication: reviewExchange.adjudications?.findLast((decision) => decision.finding_id === finding.finding_id) ?? null };
  });
  const diagnostics = [];
  const contract_source = [];
  const refs = ticket.execution_policy?.contract_evidence ?? [];
  const verifyContractSource = refs.length ? createTicketContractSource({ request: job.request, workspace }) : null;
  for (const ref of refs) {
    try { contract_source.push({ status: "validated", ...await verifyContractSource(ref) }); }
    catch (error) {
      if (!["BLOCKER_DISPOSITION_INVALID", "TICKET_CONTRACT_SOURCE_CONFLICT"].includes(error.code)) throw error;
      contract_source.push({ path: ref.path, status: "blocked", code: error.code, message: error.message });
    }
  }
  let manifest = null;
  let artifact = null;
  try { manifest = workspace.changeLedger?.observe ? await workspace.changeLedger.observe() : await workspace.changeLedger?.snapshot?.(); }
  catch (error) {
    if (!["TICKET_SOURCE_CHANGED", "TICKET_SOURCE_DRIFT", "FILE_CLAIM_CONFLICT"].includes(error.code)) throw error;
    diagnostics.push({ code: error.code, message: error.message });
    manifest = await workspace.changeLedger?.load?.() ?? null;
  }
  const source_changes = ticketSourceChanges(manifest);
  if (context?.verification_artifact_id && !diagnostics.length && !source_changes.length) {
    try { artifact = await workspace.testService.assertPassedArtifact(); }
    catch (error) {
      if (!["VERIFY_ARTIFACT_MISMATCH", "TICKET_SOURCE_CHANGED", "TICKET_SOURCE_DRIFT", "VERIFY_WORKTREE_DIRTY"].includes(error.code)) throw error;
      diagnostics.push({ code: error.code, message: error.message });
    }
  }
  const changedFiles = Object.entries(diagnostics.length ? {} : manifest?.entries ?? {}).filter(([, entry]) => !["changed", "conflict"].includes(entry.source_reconciliation?.status)).map(([path, entry]) => ({ path, sha256: entry.latest_sha }));
  const source_reconciliation = manifest && workspace.gitService?.inspectSource ? await workspace.gitService.inspectSource(manifest) : null;
  const verification = await readBlockerVerificationEvidence({ job, workspace, context, checkpoint });
  const coverage = artifact ? completeNodeReportEvidence({}, ticket, artifact).acceptance_coverage : [];
  const criteria = (ticket.acceptance_criteria ?? []).map((criterion, index) => {
    const id = `AC-${index + 1}`;
    const update = job.criterion_updates?.find((entry) => entry.criterion_id === id);
    const current = update?.files?.length > 0 && update.files.every((file) => changedFiles.some((live) => live.path === file.path && live.sha256 === file.sha256));
    const verification = coverage.find((entry) => entry.criterion_id === id)?.status;
    return { criterion_id: id, criterion, implementation: current ? "recorded" : update?.files?.length ? "stale" : "unknown",
      verification: verification ?? (artifact ? "evidence_pending" : "unverified"),
      files: current ? update.files : [], remaining_work: update?.remaining_work ?? null,
      checks: (ticket.verification_plan ?? []).filter((step) => step.criterion_ids?.includes(id)) };
  });
  const evidence = { execution_id: job.request.payload?.execution_id, source_revision: context?.source_revision,
    manifest_sha: context?.manifest_sha, commit_sha: context?.review_commit_sha, artifact_id: artifact?.artifact_id ?? null,
    changed_files: changedFiles, source_changes, criteria, diagnostics, contract_source, dependencies, source_reconciliation, verification, review_access, retained_review_source, review_findings, review_response_delivery,
    runtime_capabilities: blockerRuntimeCapabilities(workspace), architecture_decision: job.architecture_response?.disposition ?? null,
    review_status: blockerReviewStatus({ job, checkpoint, context, reviewCheckpoint, reviewExchange, retainedReviewSource: retained_review_source }) };
  const assigned = new Set(criteria.flatMap((entry) => entry.files.map((file) => file.path)));
  return { ...evidence, evidence_sha256: digest({ ...evidence, criteria: criteria.map(({ criterion_id, implementation, verification, files, checks }) => ({ criterion_id, implementation, verification, files, checks })) }), last_completed_turn: checkpoint.last_completed_turn,
    checkpoint_changed_paths: checkpoint.changed_paths ?? [],
    unassigned_changed_files: changedFiles.filter((file) => !assigned.has(file.path)),
    settled_decisions: (job.history ?? []).filter((entry) => entry.stage === "architecture_manager" && ["resolved", "sprint_required"].includes(entry.disposition?.action))
      .map((entry) => ({ summary: entry.disposition.summary, guidance: entry.disposition.guidance })),
    pending_criterion_ids: criteria.filter((entry) => !["verified", "not_applicable"].includes(entry.verification)).map((entry) => entry.criterion_id) };
}

// Binds Coder information requests to remaining criteria and detects unchanged requests despite rewording.
export function coderRequestProgress(job, request) {
  if (!job.ticket_progress) return null;
  const ids = request.criterion_ids ?? job.ticket_progress.pending_criterion_ids;
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length
    || ids.some((id) => !job.ticket_progress.pending_criterion_ids.includes(id)))
    throw blockerValidationError("/coder_request/criterion_ids", "coder_request_scope_invalid", "Request only distinct unverified AC IDs from Node ticket_progress; preserve verified work.");
  return digest({ evidence: job.ticket_progress.evidence_sha256, candidate: job.coder_exchange?.candidate?.sha256 ?? null, criterion_ids: [...ids].sort() });
}

// Validates optional implementation attribution using only current ticket-owned file receipts.
export function validateCriterionUpdates(value, job) {
  if (value.criterion_updates === undefined) return;
  const updates = value.criterion_updates;
  const progress = job.ticket_progress;
  if (!["sprint_leader", "coder"].includes(job.stage) || !progress || !Array.isArray(updates) || !updates.length || updates.length > progress.criteria.length)
    throw blockerValidationError("/criterion_updates", "criterion_progress_invalid", "SL/Coder may attribute current ticket-owned files to existing criteria; this never grants verification or completion.");
  const seen = new Set();
  for (const update of updates) {
    if (!update || Object.keys(update).some((key) => !["criterion_id", "files", "remaining_work"].includes(key))
      || !progress.criteria.some((entry) => entry.criterion_id === update.criterion_id) || seen.has(update.criterion_id)
      || !Array.isArray(update.files) || update.files.length > progress.changed_files.length
      || typeof update.remaining_work !== "string" || update.remaining_work.length > 8000
      || new Set(update.files.map((file) => file?.path)).size !== update.files.length
      || update.files.some((file) => !file || Object.keys(file).some((key) => !["path", "sha256"].includes(key))
        || !progress.changed_files.some((live) => live.path === file.path && live.sha256 === file.sha256)))
      throw blockerValidationError("/criterion_updates", "criterion_progress_unbound", "Use distinct AC IDs and exact path/sha256 pairs from Node ticket_progress.changed_files; name remaining work without claiming completion.");
    seen.add(update.criterion_id);
  }
}

// Records accepted attribution durably alongside the retained recovery job.
export function recordCriterionUpdates(job, value) {
  if (!value.criterion_updates) return;
  const updates = new Map((job.criterion_updates ?? []).map((entry) => [entry.criterion_id, entry]));
  for (const entry of value.criterion_updates) updates.set(entry.criterion_id, entry);
  job.criterion_updates = [...updates.values()];
}

// Gives SL a gap-focused decision contract and lets normal Coder execution perform approved work.
export function ticketProgressPrompt(job) {
  return [
    "Node ticket_progress separates ticket-owned writes, agent-attributed implementation and Node-verified criteria. A read, changed path or proposed patch is not acceptance. Unknown implementation needs attribution, not automatic reimplementation. Preserve checkpoint work; verify current code before editing it again.",
    "SL must decide the next action for the remaining ticket gap. Prefer resolved with concrete technical_result implementation_steps and verification_steps when the blocker is cleared within existing authority; Node resumes normal Coder at its retained checkpoint. A full proposed diff dossier is NOT required to resume. Existing permission denials, source bindings, candidate review (when a candidate exists) and verification gates still apply. Ask AM only one identified undecided Architecture question, not settled decisions.",
    "Node ticket_progress.contract_source supplies explicit historical baseline validation and current ticket-owned write provenance. A validated receipt clears checksum drift as a discovery prerequisite; do not wait for Node to supply that same result again. It does not prove API compatibility or acceptance: preserve the approved contract, implement remaining changes and run the mapped checks. A blocked receipt remains a concrete source/baseline prerequisite.",
    "Node ticket_progress.dependencies with status=validated supplies execution-bound accepted prerequisites. A done ticket is accepted by the pipeline; do not request another acceptance receipt or reapprove its integrated source. The Sprint evolves on shared source: integrated_project_changes proves inherited reviewed bytes while preserving historical approval identity. Implement this ticket on that inherited source; its own criteria still require verification and review.",
    "Node ticket_progress.source_reconciliation supplies read-only journal operation IDs/revisions/hashes, recorded commits, pending commit, current Git parent comparison and any retained transaction. Consume these facts directly; do not ask Coder or an external operator to read the same protected runtime journal. commit_scope=whole_ticket_files means commit the full final content of every file Coder changed in the ticket, including changes already present in those files, and exclude files outside the ticket. preexisting_changes is informational, not a commit blocker. Historical TICKET_BASELINE_CONFLICT from the old parent-equality check does not require journal rebinding, historical-parent reconstruction, or new Architecture approval under this policy. Normal Coder may retry through the current commit service once actual source/claim/execution checks pass; no reset or manual rewriting of journal/receipts is needed. Current source must still match the ticket's latest recorded hashes, and real approval denials remain enforced. Stale observations must be refreshed before use.",
    "Node ticket_progress.source_changes records current versus ticket hashes without approving or rejecting the code. A checksum change alone is not an execution blocker: SL returns actionable work to Coder at its retained checkpoint, preserving settled AM decisions. Coder reads current files, assesses the changes, and writes with fresh whole-file checksums. Node source reconciliation receipts preserve base, ticket and live hashes. status=merged means Node retained both disjoint edits. status=conflict supplies exact base line ranges: SL should resolve with concrete instructions for Coder to read the current file and edit only the missing ticket change against its live checksum, preserving concurrent edits. Do not wait for another external journal receipt or new Architecture approval merely for source drift. Node journals this explicit Coder resolution before normal commit and verification.",
    "Node ticket_progress.verification supplies read-only execution-bound job status, failed command diagnostics and focused check receipts, including failed artifacts not attached to context. Consume these records directly; do not ask an external operator for the same runtime evidence. Old runner versions are diagnostic evidence only, never current acceptance or tool permission. Verification pending/failure is technical recovery, not an approval denial. SL chooses recovery for the concrete failed command; preserve committed work and do not rerun a completed passing check without a new reason.",
    "Node verification.retained_attempt preserves the exact checkpoint verification job and artifact even after the current source identity changes. verification.status=missing refers only to the current source, not absence of historical receipts. receipt_index lists every retained job/check/artifact with its original path, source identity and checksum; bounded inline lists are not the full inventory. Read the verification_receipts context section and exact issued evidence_ref as needed. review_status combines the review checkpoint, durable findings, stage history and repair cycle: not_started applies only when review evidence is absent from available stores; unknown never means review did not run. finding_repair preserves existing REV identities, AM decisions and Coder checkpoint. Technical reconciliation can occur before review or during finding repair; after permitted repair and verification, independent Reviewer adjudicates the same findings. Do not invent a report or demand a future review report before its stage.",
    "Node verification.historical_checks and historical_artifacts are hash-pinned, read-only diagnostic evidence for this ticket, not current acceptance or proof of authorship/execution identity. Read exact evidence_ref paths and compare assertion causes, source and environment identities. Missing baseline evidence never proves a preexisting failure. With runtime_capabilities.baseline_recovery installed, Node executes recorded-environment recovery before this consultation and returns verification.baseline_recovery. Consume the new receipt: passed means the original plan is complete and SL can hand the retained Coder checkpoint back for its report; failed means inspect the exact attributed failure; unavailable carries the concrete runner/source/environment diagnostic. Do not request Owner permission or another read-only AM investigation merely to execute this existing Node operation. Never wait for an unrecorded historical result or alter tests/permission gates to force passing results. If the capability is absent, coordinate a permitted focused comparison or name the concrete unavailable prerequisite.",
    "Node ticket_progress.review_access probes the current Reviewer tools against the exact retained review artifact and project instructions. status=verified means that historical PATH_FORBIDDEN is no longer a current read-access prerequisite; this does not close findings or grant approval. SL should resume Coder for remaining implementation/verification work, then independent Reviewer adjudicates prior findings. A blocked access probe is a tooling diagnostic, not an automatic approval denial. Never ask Coder to change Reviewer permissions or invent denial receipts.",
    "Use coder_requested only for specific missing implementation information, with coder_request.criterion_ids naming the affected unverified criteria. Do not request a complete ticket-wide patch before implementation. Coder returns only missing information; prior findings and checkpoint changes remain available. If no new evidence or progress exists, SL must change the action or identify a specific external blocker with reconciliation.waiting_for, rather than rephrase the same request.",
    "Optionally return criterion_updates:[{criterion_id,files:[{path,sha256}],remaining_work}] to attribute already-written ticket-owned files using exact Node pairs. This records implementation evidence only, never verified/done. Report absent attribution explicitly; do not infer mappings from names or unrelated dirty files.",
    job.ticket_progress ? `NODE TICKET PROGRESS (evidence, not permissions): ${JSON.stringify(job.ticket_progress)}` : ""
  ].filter(Boolean).join("\n\n");
}

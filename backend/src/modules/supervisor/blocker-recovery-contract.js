// Validates evidence-bearing blocker dispositions without granting agents new approval authority.
import { validateCoderRequest, validateCoderCandidate, validateCandidateReview, assertCandidateSources } from "./blocker-coder-candidate.js";
import { validateTechnicalReconciliation } from "./blocker-technical-reconciliation.js";
import { validateCriterionUpdates } from "./blocker-ticket-progress.js";
import { createHash } from "node:crypto";
import { statePath } from "../../infrastructure/filesystem/forge-paths.js";
import { assertReviewerReadPath } from "./reviewer-forge-tools.js";
import { blockerSprintAuthority, assertArchitectureDisposition, assertOwnerEscalation } from "./blocker-decision-authority.js";
import { resolveBlockerAuthority } from "./blocker-authority-passages.js";
import { blockerValidationError } from "./blocker-validation.js";
import { validateBlockerContractDraft } from "./blocker-contract-draft.js";
import { assertVerificationWait } from "./blocker-verification-wait.js";
import { requiresBlockerAdmission, requiresBlockerContract, requiresEvidenceReconciliation } from "./blocker-failure-classification.js";
import { createBlockerEvidenceFiles } from "./blocker-evidence-files.js";
import { reviewerEvidenceRequest } from "./blocker-reviewer-evidence.js";
import { readReviewerEvidenceArtifact } from "./blocker-reviewer-source.js";
import { createBlockerContractFiles } from "./blocker-contract-files.js";

export const BLOCKER_REASONS = ["SCOPE_CONFLICT", "CONTRACT_DECISION_REQUIRED", "ACCEPTANCE_AMBIGUOUS", "ACCESS_REQUIRED", "SECURITY_RISK"];

// Binds recovery records and evidence to their exact persisted execution content.
export function blockerDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

// Checks frozen contract prerequisites against approved Sprint or authenticated Architecture authority without fabricating an agent decision.
export async function assertDeclaredContractEvidence(ref, { plan, ticket, architecture, fileService, projectRoot, verifyContractSource }) {
  const authorityQuote = ref.authority_quote;
  const authorities = [blockerSprintAuthority(plan, ticket), architecture?.markdown];
  if (!text(authorityQuote) || authorityQuote.length < 20 || !authorities.some((authority) => authority?.includes(authorityQuote))) {
    throw blockerValidationError("/authority_quote", "authority_not_grounded", "Declared contract evidence must quote the approved Sprint or its authenticated Architecture parent verbatim.");
  }
  if (verifyContractSource) return verifyContractSource(ref);
  await assertSourceEvidence([{ path: ref.path, sha256: ref.sha256 }], { fileService, projectRoot,
    requireContractBinding: true, contractEvidence: ticket.execution_policy?.contract_evidence ?? [], authorityQuote });
}

// Requires concrete proposals or independently verifiable, already-approved scope for an automatic resume.
export async function validateBlockerDisposition(value, { job, plan, architecture, fileService, projectRoot, verifyContractSource, contractDelegation, contractReceipts, contractFileService }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw blockerValidationError("/", "object_required", "Return one disposition object.");
  value = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined));
  const unknown = Object.keys(value).find((key) => !["action", "summary", "guidance", "authority_quote", "authority_reference", "evidence", "proposal", "authority_scope", "architecture_basis", "boundary_assessment", "escalation", "contract_draft", "reconciliation", "technical_result", "coder_request", "candidate", "candidate_review", "criterion_updates"].includes(key));
  if (unknown !== undefined) throw blockerValidationError("/", "additional_property", `Remove unsupported disposition property: ${unknown}.`);
  if (!["resolved", "architecture_required", "owner_required", "governance_required", "reconciliation_required", "coder_requested", "candidate_prepared", "sprint_required"].includes(value.action)) throw blockerValidationError("/action", "action_invalid", "Use resolved, architecture_required, owner_required, governance_required, reconciliation_required, coder_requested, candidate_prepared or sprint_required.");
  if (!text(value.summary) || value.summary.length > 8000) throw blockerValidationError("/summary", "summary_invalid", "Provide a nonempty summary within 8000 characters.");
  const { files } = createBlockerEvidenceFiles({ projectRoot, profile: { role: job?.stage }, taskId: job?.request?.task_id, job,
    files: { assertReadPath: (path) => assertReviewerReadPath(projectRoot, path), readFile: (input) => fileService.readFile(input) } });
  const evidenceFiles = createBlockerContractFiles({ files, stateFiles: contractFileService, receipts: contractReceipts, job });
  validateCriterionUpdates(value, job);
  if (job?.stage === "coder" || value.action === "candidate_prepared") return validateCoderCandidate(value, { job, fileService, projectRoot });
  if (value.candidate !== undefined || value.coder_request !== undefined && value.action !== "coder_requested") throw blockerValidationError("/", "candidate_action_mismatch", "Candidate data belongs to candidate_prepared and requests to coder_requested.");
  if (value.action === "sprint_required") {
    if (job?.stage === "sprint_leader") throw blockerValidationError("/action", "role_action_mismatch",
      "sprint_required is AM's answer to SL. SL must return resolved with authority_scope=sprint, a Sprint authority reference and concrete guidance to continue Coder from the retained checkpoint when no prerequisite remains; do not repeat the settled AM consultation.");
    const authorityQuote = resolveBlockerAuthority(value, { plan, ticket: job.request.ticket, architecture });
    assertArchitectureDisposition(value, { job, architecture, authorityQuote });
    if (!text(value.guidance) || value.guidance.length > 8000 || requiresBlockerAdmission(job))
      throw blockerValidationError("/guidance", "sprint_handoff_invalid", "Delegate implementation guidance only; access/security boundaries remain with AM.");
    await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles });
    return { ...value, authority_quote: authorityQuote };
  }
  if (value.action === "coder_requested") {
    validateCoderRequest(value, job);
    if (value.evidence !== undefined) await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles });
    return value;
  }
  if (job?.stage === "sprint_leader" && job.coder_exchange?.candidate && value.action === "resolved") {
    validateCandidateReview(value.candidate_review, job);
    await assertCandidateSources(job.coder_exchange.candidate, { fileService, projectRoot });
  } else if (value.candidate_review !== undefined) throw blockerValidationError("/candidate_review", "candidate_action_mismatch", "A candidate verdict requires the current AM resolved or coder_requested response.");
  if (value.action === "reconciliation_required" && value.reconciliation?.kind === "execution_admission"
    && job.reason_code === "ACCESS_REQUIRED" && !requiresBlockerAdmission(job)) {
    throw blockerValidationError("/reconciliation/kind", "execution_admission_misclassified",
      "No evidenced access decision requires admission here. Use tooling or source_revision reconciliation for missing receipts or technical failures; after a settled AM answer, return concrete SL guidance instead of requesting another Node admission step. Actual tool authorization remains enforced.");
  }
  validateTechnicalReconciliation(value, job);
  if (reviewerEvidenceRequest(value)) await readReviewerEvidenceArtifact({ job, projectRoot, subject: reviewerEvidenceRequest(value).subject });
  if (value.action === "governance_required") return validateBlockerContractDraft(value, { job, fileService, projectRoot });
  if (value.contract_draft) throw blockerValidationError("/contract_draft", "action_mismatch", "A contract draft requires governance_required; it is not execution authority.");
  if (value.action === "reconciliation_required") {
    assertVerificationWait(value, job);
    if (!text(value.guidance) || value.guidance.length > 8000) throw blockerValidationError("/guidance", "guidance_invalid", "Identify the unresolved technical prerequisite and the required reconciliation without authorizing Coder resume.");
    if (value.evidence !== undefined) await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles });
    return value;
  }
  if (value.action === "architecture_required") {
    if (job?.stage === "architecture_manager") throw blockerValidationError("/action", "architecture_stage_terminal", "AM must resolve the blocker, report reconciliation_required or return owner_required with a bounded escalation; it cannot delegate the decision back to Architecture.");
    if (value.evidence !== undefined) await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles });
    return value;
  }
  if (value.action === "owner_required") {
    if (job?.fulfillment_decision_id) throw blockerValidationError("/action", "owner_fulfillment_required", "This stage fulfills an existing owner choice. Return resolved within the approved structure or a concrete governance_required draft; technical handoff failures require reconciliation, not another policy vote.", { retryable: false });
    if (job?.stage === "sprint_leader") return { ...value, action: "architecture_required" };
    const proposal = value.proposal;
    if (!proposal || !text(proposal.title) || !Array.isArray(proposal.options) || proposal.options.length < 2 || proposal.options.length > 4
      || proposal.options.some((option) => !text(option.id) || !text(option.description))
      || new Set(proposal.options.map((option) => option.id)).size !== proposal.options.length
      || !proposal.options.some((option) => option.id === proposal.recommended_option_id)) throw invalid("Owner escalation needs concrete options and a recommendation.");
    const declaredScope = ["sprint", "architecture"].includes(value.authority_scope) ? value.authority_scope : undefined;
    const escalationScope = ["sprint", "architecture"].includes(value.escalation?.authority_scope) ? value.escalation.authority_scope : declaredScope;
    const escalationQuote = value.escalation?.authority_reference === undefined ? undefined
      : resolveBlockerAuthority({ ...value.escalation, authority_scope: escalationScope ?? "sprint" }, { plan, ticket: job.request.ticket, architecture });
    assertOwnerEscalation(value, { job, plan, architecture, authorityQuote: escalationQuote ?? value.escalation?.authority_quote });
    if (job?.stage === "architecture_manager" && !Object.values(value.boundary_assessment ?? {}).some((flag) => flag === true))
      throw blockerValidationError("/boundary_assessment", "delegated_to_architecture", "AM decides within the approved plan. Consult Owner only when a grounded impact flag proves the decision exceeds approved scope or carries material project-structure risk.");
    await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles });
    if (escalationQuote !== undefined) value = { ...value, escalation: { ...value.escalation, authority_quote: escalationQuote } };
    return value;
  }
  const ticket = job.request.ticket;
  const scope = value.authority_scope ?? "sprint";
  if (!["sprint", "architecture"].includes(scope)) throw blockerValidationError("/authority_scope", "scope_invalid", "Use sprint or architecture authority scope.");
  const delegated = job.stage === "sprint_leader" && job.sprint_delegation;
  if (delegated) {
    assertArchitectureDisposition(job.sprint_delegation, { job: { ...job, stage: "architecture_manager" }, architecture });
    await assertSourceEvidence(job.sprint_delegation.evidence, { fileService, projectRoot, evidenceFiles });
  }
  const retainedDelegation = job.stage === "sprint_leader" && contractDelegation;
  if (retainedDelegation) assertArchitectureDisposition(contractDelegation, { job: { ...job, stage: "architecture_manager" }, architecture });
  const accessDecision = delegated ? job.sprint_delegation : retainedDelegation;
  const accessAnswer = accessDecision?.action === "resolved" && accessDecision.technical_result?.admission?.status === "within_existing_permissions";
  // Node cannot classify the failure without complete original receipts. Route that gap to concrete evidence
  // reconciliation, not a policy/AM admission escalation and not an agent self-certified resolved handoff.
  if (requiresEvidenceReconciliation(job) && value.action === "resolved" && !accessAnswer) {
    throw blockerValidationError("/action", "failure_evidence_incomplete",
      "Node's original failure receipts are incomplete or unrecognized, so the blocker cannot be cleared as resolved yet. Re-inspect the cited sources and report the precise missing receipt as reconciliation_required; this is a technical evidence gap, not an approval denial or a new Owner policy question.", { retryable: true });
  }
  if (requiresBlockerAdmission(job) && !accessAnswer && !(job?.stage === "architecture_manager" && scope === "architecture")) {
    throw blockerValidationError("/action", "access_or_security_authority_required",
      "Sprint scope cannot resolve access or security blockers; SL must return architecture_required, and AM must resolve at authority_scope=architecture (with all six boundary_assessment flags false) or return owner_required when new access/security policy is needed.", { retryable: true });
  }
  const authorityQuote = resolveBlockerAuthority(value, { plan, ticket, architecture });
  if (scope === "architecture") assertArchitectureDisposition(value, { job, architecture, authorityQuote });
  const authority = scope === "architecture" ? architecture.markdown : blockerSprintAuthority(plan, ticket);
  if (!text(authorityQuote) || authorityQuote.length < 20 || !authority.includes(authorityQuote)) throw blockerValidationError("/authority_quote", "authority_not_grounded", "Select a Node-issued authority_reference and explain its applicability, or supply a verbatim approved quote.");
  if (!text(value.guidance) || value.guidance.length > 8000) throw blockerValidationError("/guidance", "guidance_invalid", "Provide concrete implementation guidance within the approved scope.");
  const requireContractBinding = requiresBlockerContract(job) && !delegated && !retainedDelegation && (job.stage !== "architecture_manager" || scope !== "architecture");
  if (requireContractBinding && verifyContractSource) {
    const refs = ticket.execution_policy?.contract_evidence ?? [];
    if (!refs.length) throw blockerValidationError("/action", "approved_contract_evidence_missing",
      "A contract requires approved contract evidence; source existence alone is not approval.",
      { expected: "Use architecture_required for an unresolved contract decision, or reconciliation_required for missing baseline/verification receipts. Resume is not authorized until the prerequisite is evidenced or an authenticated AM contract delegation applies." });
    for (const ref of refs) await assertDeclaredContractEvidence(ref, { plan, ticket, architecture, verifyContractSource });
  }
  await assertSourceEvidence(value.evidence, { fileService, projectRoot, evidenceFiles,
    requireContractBinding,
    contractEvidence: ticket.execution_policy?.contract_evidence ?? [], authorityQuote, verifyContractSource });
  return { ...value, authority_quote: authorityQuote };
}

// Verifies 1-16 real source file checksums and enforces pre-approved contract bindings for non-AM stages.
async function assertSourceEvidence(evidenceList, { fileService, projectRoot, evidenceFiles, requireContractBinding = false, contractEvidence = [], authorityQuote, verifyContractSource } = {}) {
  if (!Array.isArray(evidenceList) || !evidenceList.length || evidenceList.length > 16) throw blockerValidationError("/evidence", "evidence_invalid", "Provide one to sixteen verifiable source references.");
  for (const [index, evidence] of evidenceList.entries()) {
    if (!evidence || !text(evidence.path)) throw blockerValidationError(`/evidence/${index}/path`, "path_required", "Evidence requires a source path.");
    if (!/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")) throw blockerValidationError(`/evidence/${index}/sha256`, "checksum_invalid", "Provide the full SHA-256 of the inspected source file.");
    if (requireContractBinding && verifyContractSource) {
      const ref = contractEvidence.find((entry) => entry.path === evidence.path);
      if (ref) {
        const receipt = await verifyContractSource(ref);
        if (![receipt.baseline_sha256, receipt.current_sha256].includes(evidence.sha256)) throw blockerValidationError(`/evidence/${index}/sha256`, "evidence_stale", "Evidence matches neither the approved baseline nor the ticket-owned current source.");
        continue;
      }
    }
    try {
      if (evidenceFiles) await evidenceFiles.assertReadPath(evidence.path);
      else await assertReviewerReadPath(projectRoot, evidence.path);
    } catch (error) {
      if (error.code === "FILE_ROLE_FORBIDDEN" && String(evidence.path).startsWith(`${statePath()}/blocker-contract-decisions/`))
        throw blockerValidationError(`/evidence/${index}/path`, "contract_receipt_not_issued", "Cite only the exact path and SHA-256 of an authenticated AM receipt supplied by Node in contract_context. An arbitrary runtime file is not source evidence.");
      // A cited Node context delivery copy must return correctable feedback, not a raw role rejection that parks recovery without an automatic-correction round.
      if (error.code !== "FILE_ROLE_FORBIDDEN" || !String(evidence.path ?? "").startsWith(`${statePath()}/blocker-context/`)) throw error;
      throw blockerValidationError(`/evidence/${index}/path`, "evidence_not_source", "Blocker evidence must cite inspected original project source files or Node-granted verification receipts, never READ-ONLY FULL CONTEXT INDEX delivery copies. Re-read the original source with read_file and cite its path with the current full-file sha256.");
    }
    let content;
    try { content = await (evidenceFiles ?? fileService).readFile({ path: evidence.path }); }
    catch (error) {
      if (!["ENOENT", "FILE_NOT_FOUND"].includes(error.code)) throw error;
      throw blockerValidationError(`/evidence/${index}/path`, "evidence_missing", "The cited source file does not exist. Remove its invented source checksum; cite inspected existing source and report the absent proposed file as a diagnostic. No mutation or retry permission is granted.");
    }
    if (createHash("sha256").update(content).digest("hex") !== evidence.sha256) throw blockerValidationError(`/evidence/${index}/sha256`, "evidence_stale", "Blocker evidence is stale. Re-read the source; do not invent a checksum.");
    if (requireContractBinding && !verifyContractSource && !contractEvidence.some((ref) => ref.path === evidence.path && ref.sha256 === evidence.sha256 && ref.authority_quote === authorityQuote))
      throw invalid("A contract requires an exact approved contract evidence binding; source existence alone is not approval.");
  }
}

// Rejects empty protocol fields rather than treating narrative approval as authority.
function text(value) { return typeof value === "string" && value.trim().length > 0; }

// Identifies malformed agent output separately from a Coder implementation failure.
function invalid(message) { return Object.assign(new Error(message), { code: "BLOCKER_DISPOSITION_INVALID" }); }

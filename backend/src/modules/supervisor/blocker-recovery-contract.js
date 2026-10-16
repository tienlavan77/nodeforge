// Validates evidence-bearing blocker dispositions without granting agents new approval authority.
import { createHash } from "node:crypto";
import { assertReviewerReadPath } from "./reviewer-forge-tools.js";
import { blockerSprintAuthority, assertArchitectureDisposition, assertOwnerEscalation } from "./blocker-decision-authority.js";
import { resolveBlockerAuthority } from "./blocker-authority-passages.js";
import { blockerValidationError } from "./blocker-validation.js";

export const BLOCKER_REASONS = ["SCOPE_CONFLICT", "CONTRACT_DECISION_REQUIRED", "ACCEPTANCE_AMBIGUOUS", "ACCESS_REQUIRED", "SECURITY_RISK"];

// Binds recovery records and evidence to their exact persisted execution content.
export function blockerDigest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

// Requires concrete proposals or independently verifiable, already-approved scope for an automatic resume.
export async function validateBlockerDisposition(value, { job, plan, architecture, fileService, projectRoot }) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw blockerValidationError("/", "object_required", "Return one disposition object.");
  const unknown = Object.keys(value).find((key) => !["action", "summary", "guidance", "authority_quote", "authority_reference", "evidence", "proposal", "authority_scope", "architecture_basis", "boundary_assessment", "escalation"].includes(key));
  if (unknown !== undefined) throw blockerValidationError("/", "additional_property", `Remove unsupported disposition property: ${unknown}.`);
  if (!["resolved", "architecture_required", "owner_required"].includes(value.action)) throw blockerValidationError("/action", "action_invalid", "Use resolved, architecture_required or owner_required.");
  if (!text(value.summary) || value.summary.length > 8000) throw blockerValidationError("/summary", "summary_invalid", "Provide a nonempty summary within 8000 characters.");
  if (value.action === "architecture_required") {
    if (job?.stage === "architecture_manager") throw blockerValidationError("/action", "architecture_stage_terminal", "AM must resolve the blocker or return owner_required with a bounded escalation; it cannot delegate the decision back to Architecture.");
    return value;
  }
  if (value.action === "owner_required") {
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
    if (escalationQuote !== undefined) value = { ...value, escalation: { ...value.escalation, authority_quote: escalationQuote } };
    return value;
  }
  if (["ACCESS_REQUIRED", "SECURITY_RISK"].includes(job.reason_code)) throw invalid("Agents cannot resolve access or security authority.");
  const ticket = job.request.ticket;
  const scope = value.authority_scope ?? "sprint";
  if (!["sprint", "architecture"].includes(scope)) throw blockerValidationError("/authority_scope", "scope_invalid", "Use sprint or architecture authority scope.");
  const authorityQuote = resolveBlockerAuthority(value, { plan, ticket, architecture });
  if (scope === "architecture") assertArchitectureDisposition(value, { job, architecture, authorityQuote });
  const authority = scope === "architecture" ? architecture.markdown : blockerSprintAuthority(plan, ticket);
  if (!text(authorityQuote) || authorityQuote.length < 20 || !authority.includes(authorityQuote)) throw blockerValidationError("/authority_quote", "authority_not_grounded", "Select a Node-issued authority_reference and explain its applicability, or supply a verbatim approved quote.");
  if (!text(value.guidance) || value.guidance.length > 8000) throw blockerValidationError("/guidance", "guidance_invalid", "Provide concrete implementation guidance within the approved scope.");
  if (!Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 8) throw blockerValidationError("/evidence", "evidence_invalid", "Provide one to eight verifiable source references.");
  for (const [index, evidence] of value.evidence.entries()) {
    if (!evidence || !text(evidence.path)) throw blockerValidationError(`/evidence/${index}/path`, "path_required", "Evidence requires a source path.");
    if (!/^[a-f0-9]{64}$/.test(evidence.sha256 ?? "")) throw blockerValidationError(`/evidence/${index}/sha256`, "checksum_invalid", "Provide the full SHA-256 of the inspected source file.");
    await assertReviewerReadPath(projectRoot, evidence.path);
    const content = await fileService.readFile({ path: evidence.path });
    if (createHash("sha256").update(content).digest("hex") !== evidence.sha256) throw blockerValidationError(`/evidence/${index}/sha256`, "evidence_stale", "Blocker evidence is stale. Re-read the source; do not invent a checksum.");
    if (job.reason_code === "CONTRACT_DECISION_REQUIRED" && !(ticket.execution_policy?.contract_evidence ?? [])
      .some((ref) => ref.path === evidence.path && ref.sha256 === evidence.sha256 && ref.authority_quote === authorityQuote)) throw invalid("A contract requires an exact approved contract evidence binding; source existence alone is not approval.");
  }
  return value;
}

// Rejects empty protocol fields rather than treating narrative approval as authority.
function text(value) { return typeof value === "string" && value.trim().length > 0; }

// Identifies malformed agent output separately from a Coder implementation failure.
function invalid(message) { return Object.assign(new Error(message), { code: "BLOCKER_DISPOSITION_INVALID" }); }

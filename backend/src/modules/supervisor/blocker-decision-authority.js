// Binds automatic SL/AM decisions to approved Sprint and Architecture boundaries without fabricating owner approval.
import { isDeepStrictEqual } from "node:util";
import { blockerValidationError } from "./blocker-validation.js";

export const OWNER_BOUNDARIES = ["system_structure", "owner_scope", "security_policy", "data_semantics", "explicit_owner_guardrail"];
const IMPACTS = ["changes_structure", "changes_owner_scope", "changes_security_policy", "changes_data_semantics", "overrides_guardrails", "changes_ticket_contract"];
const BOUNDARY_TO_IMPACT = {
  system_structure: ["changes_structure"],
  owner_scope: ["changes_owner_scope"],
  security_policy: ["changes_security_policy"],
  data_semantics: ["changes_data_semantics"],
  explicit_owner_guardrail: ["overrides_guardrails", "changes_ticket_contract"]
};

// Loads only the exact authenticated Architecture parent of the already-approved Sprint projection.
export async function approvedBlockerArchitecture(plan, projectId, architecturePlans) {
  if (!architecturePlans?.assertApproved) return null;
  const match = plan.proposal_id?.match(/^(.+)-R([1-9]\d*)-([a-f0-9]{64})$/);
  if (!match) return null;
  const parent = await architecturePlans.assertApproved({ planId: match[1], revision: Number(match[2]), sha256: match[3] });
  if (parent.project_id !== projectId || parent.plan_id !== match[1] || parent.revision !== Number(match[2]) || parent.sha256 !== match[3]
    || parent.file_path !== plan.source_path || parent.sha256 !== plan.source_sha256 || typeof parent.markdown !== "string"
    || parent.markdown.length > 120_000) throw invalid("Architecture authority does not match the approved Sprint parent.");
  return { basis: { plan_id: parent.plan_id, revision: parent.revision, sha256: parent.sha256 }, markdown: parent.markdown };
}

// Supplies Sprint-level implementation authority while keeping exclusions separate from affirmative permission.
export function blockerSprintAuthority(plan, ticket, { includeExclusions = false } = {}) {
  return [ticket.objective, ...(ticket.acceptance_criteria ?? []), ticket.execution_contract?.scope,
    ...(ticket.owner_decisions ?? []).map((decision) => decision.description), plan.content?.objective, plan.content?.in_scope,
    plan.content?.approach, ...(plan.content?.acceptance_criteria ?? []),
    ...(plan.content?.architecture_decisions?.decisions ?? []).map((decision) => decision.description),
    ...(includeExclusions ? [plan.content?.out_of_scope] : [])].filter(Boolean).join("\n");
}

// Requires explicit bounded impact assessment for AM's technical choices within the approved system structure.
export function assertArchitectureDisposition(value, { job, architecture, authorityQuote = value.authority_quote }) {
  if (job.stage !== "architecture_manager") throw blockerValidationError("/authority_scope", "role_not_authorized",
    "Only AM may decide at Architecture scope. SL must use Sprint scope and a Sprint authority reference for its own coordination decision; preserve the validated AM answer separately. If a new design decision remains, return architecture_required.",
    { expected: "sprint", received: value.authority_scope ?? null, retryable: job.stage === "sprint_leader" });
  if (!architecture) throw blockerValidationError("/architecture_basis", "approved_parent_unavailable", "No authenticated approved Architecture parent is available.", { retryable: false });
  if (value.authority_scope !== "architecture") throw blockerValidationError("/authority_scope", "reference_scope_mismatch",
    "This AM disposition delegates or decides an Architecture-bound contract. Use authority_scope=architecture with a Node-issued Architecture passage and the exact Node-verified architecture_basis.",
    { expected: "architecture", received: value.authority_scope ?? null });
  const identityErrors = ["plan_id", "revision", "sha256"].filter((field) => value.architecture_basis?.[field] !== architecture.basis[field])
    .flatMap((field) => blockerValidationError(`/architecture_basis/${field}`, "identity_mismatch", "Copy the exact Node-verified Architecture identity; reasoning may be paraphrased but identity cannot.",
      { expected: architecture.basis[field], received: value.architecture_basis?.[field] ?? null }).validation_errors);
  if (identityErrors.length) throw Object.assign(blockerValidationError(identityErrors[0].path, identityErrors[0].reason, identityErrors[0].message), { validation_errors: identityErrors });
  if (!isDeepStrictEqual(value.architecture_basis, architecture.basis)) throw blockerValidationError("/architecture_basis", "identity_shape_invalid", "Architecture identity may contain only plan_id, revision and sha256.");
  if (typeof authorityQuote !== "string" || !architecture.markdown.includes(authorityQuote)) throw blockerValidationError("/authority_quote", "authority_not_grounded", "Use a Node-issued authority_reference with your rationale instead of copying a quotation, or provide a verbatim approved quote.");
  const assessment = value.boundary_assessment;
  if (!assessment || !text(assessment.rationale) || assessment.rationale.length > 8000 || Object.keys(assessment).some((key) => ![...IMPACTS, "rationale"].includes(key))) throw blockerValidationError("/boundary_assessment", "assessment_invalid", "Provide a rationale and the six explicit boundary impact flags.");
  for (const field of IMPACTS) {
    if (assessment[field] !== false) throw blockerValidationError(`/boundary_assessment/${field}`, "boundary_not_preserved", "AM cannot override structure, owner policy, guardrails or the immutable ticket contract.",
      { expected: false, received: assessment[field] ?? null, retryable: assessment[field] !== true });
  }
}

// Escalates only an evidenced boundary beyond AM authority, not ordinary technical uncertainty.
// Field-specific feedback lets AM correct one mistake instead of guessing at a combined rejection.
export function assertOwnerEscalation(value, { job, plan, architecture, authorityQuote = value.escalation?.authority_quote }) {
  if (job?.stage !== "architecture_manager") throw blockerValidationError("/escalation", "role_not_authorized", "Only AM may request an owner decision; SL must return architecture_required instead.", { retryable: false });
  const rawEscalation = value.escalation;
  if (!rawEscalation || typeof rawEscalation !== "object" || Array.isArray(rawEscalation)) throw blockerValidationError("/escalation", "escalation_required", "Provide escalation with boundary, rationale and a grounded authority quote or reference.");
  const escalation = Object.fromEntries(Object.entries(rawEscalation).filter(([, entry]) => entry !== null && entry !== undefined));
  const unknown = Object.keys(escalation).find((key) => !["boundary", "rationale", "authority_quote", "authority_reference", "authority_scope"].includes(key));
  if (unknown !== undefined) throw blockerValidationError("/escalation", "additional_property", `Remove unsupported escalation property: ${unknown}.`);
  if (escalation.authority_quote !== undefined && escalation.authority_reference !== undefined) throw blockerValidationError("/escalation", "authority_duplicate", "Use either authority_quote or authority_reference, not both.");
  if (!OWNER_BOUNDARIES.includes(escalation.boundary)) throw blockerValidationError("/escalation/boundary", "boundary_invalid", "Name the owner boundary being crossed.", { expected: OWNER_BOUNDARIES, received: escalation.boundary ?? null });
  if (!text(escalation.rationale) || escalation.rationale.length > 8000) throw blockerValidationError("/escalation/rationale", "rationale_invalid", "Explain within 8000 characters why the decision exceeds AM authority.");
  const scope = [blockerSprintAuthority(plan, job.request.ticket, { includeExclusions: true }), architecture?.markdown ?? ""];
  if (typeof authorityQuote !== "string" || authorityQuote.trim().length < 20) throw blockerValidationError("/escalation/authority_quote", "quote_invalid", "Copy one approved Sprint or Architecture passage verbatim (at least 20 characters), or cite escalation.authority_reference={passage_id,rationale} from authority_context.passages.");
  if (!scope.some((entry) => entry.includes(authorityQuote))) throw blockerValidationError("/escalation/authority_quote", "quote_not_grounded", "The authority_quote is not verbatim in the approved Sprint or Architecture text. Copy one passage exactly (no composition, joins, reformatting or added markers), or cite escalation.authority_reference={passage_id,rationale} from Node's authority_context.passages.", { received: authorityQuote.slice(0, 240) });
  const assessment = value.boundary_assessment;
  if (!assessment || !text(assessment.rationale) || assessment.rationale.length > 8000 || Object.keys(assessment).some((key) => ![...IMPACTS, "rationale"].includes(key))
    || IMPACTS.some((field) => typeof assessment[field] !== "boolean")) throw blockerValidationError("/boundary_assessment", "assessment_invalid", "Provide boundary_assessment with a rationale and the six boolean boundary impact flags.");
  if (IMPACTS.every((field) => assessment[field] === false)) throw blockerValidationError("/boundary_assessment", "delegated_to_architecture", "All boundary impact flags are false; no new owner policy decision is established. Return action=resolved only when the blocker is cleared, otherwise action=reconciliation_required with the remaining technical prerequisite and concrete guidance.", { retryable: true });
  if (value.action === "owner_required" && priorAllFalseAssessment(job)) throw blockerValidationError("/boundary_assessment", "boundary_inflation_forbidden", "A prior attempt in this stage established that all boundary impact flags are false; AM cannot inflate impact flags on retry to escalate.", { retryable: true });
  const requiredImpacts = BOUNDARY_TO_IMPACT[escalation.boundary] ?? [];
  if (!requiredImpacts.some((field) => assessment[field] === true)) throw blockerValidationError("/boundary_assessment", "escalation_boundary_mismatch", `Escalation boundary ${escalation.boundary} requires at least one matching impact flag (${requiredImpacts.join(", ")}) to be true.`, { expected: requiredImpacts, received: Object.fromEntries(requiredImpacts.map((field) => [field, assessment[field]])) });
}

// Rejects a retry that inflates boundary flags only when an earlier attempt's all-false assessment was itself the substantive rejection.
// A prior response rejected for identity, quotation, scope or schema was never a settled no-boundary judgment, so it cannot bar a genuinely evidenced escalation.
const BOUNDARY_ATTESTATION_REASONS = new Set(["delegated_to_architecture", "boundary_inflation_forbidden"]);

// Detects whether an earlier rejected attempt in the current AM stage already attested that no owner boundaries were crossed.
function priorAllFalseAssessment(job) {
  return (job?.disposition_attempts ?? []).some((attempt) => {
    if (attempt?.stage !== "architecture_manager" || attempt?.status !== "rejected") return false;
    if (!(attempt?.validation_errors ?? []).some((error) => BOUNDARY_ATTESTATION_REASONS.has(error?.reason))) return false;
    const raw = attempt.response?.text ?? attempt.response;
    try {
      const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
      return Boolean(parsed?.boundary_assessment && IMPACTS.every((field) => parsed.boundary_assessment[field] === false));
    } catch (error) { return error && false; }
  });
}

// Rejects empty authority claims instead of accepting ungrounded agent narrative.
function text(value) { return typeof value === "string" && value.trim().length > 0; }

// Keeps unsupported authority claims separate from implementation or provider failures.
function invalid(message) { return Object.assign(new Error(message), { code: "BLOCKER_DISPOSITION_INVALID" }); }

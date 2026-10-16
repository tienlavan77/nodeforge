// Rejects Reviewer findings that cannot guide an evidence-bound Coder repair.
import { ConfigurationError } from "../../shared/errors.js";

// Enforces canonical guidance in legacy and strict reviews without inventing evidence for legacy strings.
export function assertReviewFindingGuidance(value, { strict = false, paths, artifactId } = {}) {
  if (value.findings.some((finding) => !validFinding(finding))) invalid("Reviewer findings require failure, acceptance criterion, evidence location, and minimum change scope; legacy strings require re-review.");
  if (paths && value.findings.some((finding) => !finding.evidence_refs.some((reference) =>
    paths.some((path) => reference === path || reference.startsWith(`${path}:`) || reference.startsWith(`${path}#L`))
    || artifactId && reference.includes(artifactId)))) invalid("Reviewer finding must cite a supplied source location or the current verification artifact.");
  if ((strict || value.adjudications !== undefined) && (!Array.isArray(value.adjudications)
    || value.adjudications.some((item) => !item || !/^REV-[1-9][0-9]*$/.test(item.finding_id ?? "")
      || !["retain", "refine", "withdraw", "not_applicable", "fixed"].includes(item.decision)
      || !text(item.reason) || !references(item.evidence_refs)))) invalid("Reviewer adjudications require a finding identity, decision, reason, and evidence.");
}

// Checks actionable canonical fields and per-file scope justification before dispatching a repair.
function validFinding(finding) {
  if (!finding || typeof finding !== "object" || Array.isArray(finding)
    || ![finding.failure, finding.acceptance_criterion, finding.minimum_change_scope].every(text)
    || !references(finding.evidence_refs)) return false;
  if (finding.files !== undefined && (!Array.isArray(finding.files) || !finding.files.every(text))) return false;
  if (finding.per_file_necessity !== undefined && (!Array.isArray(finding.per_file_necessity)
    || finding.per_file_necessity.some((part) => !part || !text(part.path) || !text(part.role)))) return false;
  if ((finding.files?.length ?? 0) > 1) {
    const paths = finding.per_file_necessity?.map((part) => part.path) ?? [];
    if (new Set(finding.files).size !== finding.files.length || paths.length !== finding.files.length
      || new Set(paths).size !== paths.length || finding.files.some((path) => !paths.includes(path))) return false;
  }
  return true;
}

// Requires evidence references to carry actual bounded text, not blank or malformed values.
function references(value) { return Array.isArray(value) && value.length > 0 && value.every(text); }

// Protects untrusted verdict parsing from type errors masquerading as valid guidance.
function text(value) { return typeof value === "string" && value.trim().length > 0; }

// Keeps malformed guidance in the Reviewer operational failure path, never the Coder repair path.
function invalid(message) { throw Object.assign(new ConfigurationError(message), { code: "REVIEW_VERDICT_INVALID" }); }

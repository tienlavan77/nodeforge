// Rejects Reviewer findings that cannot guide an evidence-bound Coder repair.
import { ConfigurationError } from "../../shared/errors.js";

// Enforces canonical guidance in legacy and strict reviews without inventing evidence for legacy strings.
export function assertReviewFindingGuidance(value, { strict = false, paths, artifactId, findingIds, pendingResponses = [] } = {}) {
  value.findings.forEach((finding, index) => assertFinding(finding, index));
  if (value.verdict === "approved" && value.findings.length) {
    value.findings.forEach((finding, index) => {
      if (!finding || typeof finding !== "object" || String(finding.severity ?? "").toLowerCase() !== "minor" || finding.defer_to_backlog !== true) {
        invalid(`findings[${index}] cannot accompany verdict "approved" unless severity is "minor" and defer_to_backlog is true.`);
      }
    });
  }
  value.findings.forEach((finding, index) => {
    if (finding.finding_id !== undefined && (!/^REV-[1-9][0-9]*$/.test(finding.finding_id)
      || findingIds && !findingIds.includes(finding.finding_id))) invalid(`findings[${index}].finding_id must copy an existing persisted REV-<number> ID; omit finding_id for a new finding. Known IDs: ${JSON.stringify(findingIds ?? [])}.`);
  });
  if (paths && value.findings.some((finding) => !finding.evidence_refs.some((reference) =>
    paths.some((path) => reference === path || reference.startsWith(`${path}:`) || reference.startsWith(`${path}#L`))
    || artifactId && reference.includes(artifactId)))) invalid("Reviewer finding must cite a supplied source location or the current verification artifact.");
  if (strict || value.adjudications !== undefined) {
    if (!Array.isArray(value.adjudications)) invalid("adjudications must be an array; use [] when there are no prior findings to adjudicate.");
    const seen = new Set();
    value.adjudications.forEach((item, index) => {
      const location = `adjudications[${index}]`;
      if (!item || typeof item !== "object" || Array.isArray(item)) invalid(`${location} must be an adjudication object.`);
      if (!/^REV-[1-9][0-9]*$/.test(item.finding_id ?? "")) invalid(`${location}.finding_id must use the persisted REV-<number> identity, not a ticket-prefixed or invented ID.`);
      if (findingIds && !findingIds.includes(item.finding_id)) invalid(`${location}.finding_id is unknown; use one of ${JSON.stringify(findingIds)}.`);
      if (seen.has(item.finding_id)) invalid(`${location}.finding_id duplicates another adjudication.`);
      seen.add(item.finding_id);
      if (!["retain", "refine", "reopen", "withdraw", "not_applicable", "fixed"].includes(item.decision)) invalid(`${location}.decision must be retain|refine|reopen|withdraw|not_applicable|fixed.`);
      if (!text(item.reason)) invalid(`${location}.reason must be a non-empty string.`);
      if (!references(item.evidence_refs)) invalid(`${location}.evidence_refs must be a non-empty array of evidence locations.`);
    });
  }
  for (const response of pendingResponses) if (!value.adjudications?.some((decision) => decision.finding_id === response.finding_id
    && (!decision.response_id || decision.response_id === response.response_id))) invalid(`adjudications must address pending Coder response ${response.response_id} for ${response.finding_id}.`);
}

// Checks actionable canonical fields and per-file scope justification before dispatching a repair.
function assertFinding(finding, index) {
  const location = `findings[${index}]`;
  if (!finding || typeof finding !== "object" || Array.isArray(finding)) invalid(`${location} must be a structured finding object; legacy strings require re-review.`);
  for (const field of ["failure", "acceptance_criterion", "minimum_change_scope"]) {
    if (!text(finding[field])) invalid(`${location}.${field} must be a non-empty string.`);
  }
  if (!references(finding.evidence_refs)) invalid(`${location}.evidence_refs must be a non-empty array of evidence locations.`);
  if (finding.files !== undefined && (!Array.isArray(finding.files) || !finding.files.every(text))) invalid(`${location}.files must be an array of non-empty file paths.`);
  if (finding.per_file_necessity !== undefined) {
    if (!Array.isArray(finding.per_file_necessity)) invalid(`${location}.per_file_necessity must be an array of {path, role} objects.`);
    finding.per_file_necessity.forEach((part, partIndex) => {
      const entry = `${location}.per_file_necessity[${partIndex}]`;
      if (!part || typeof part !== "object" || Array.isArray(part)) invalid(`${entry} must be a {path, role} object.`);
      if (!text(part.path)) invalid(`${entry}.path must be a non-empty string.${Object.hasOwn(part, "file") ? ' Use "path", not "file".' : ""}`);
      if (!text(part.role)) invalid(`${entry}.role must describe why this file needs changes.`);
    });
  }
  if ((finding.files?.length ?? 0) > 1) {
    const paths = finding.per_file_necessity?.map((part) => part.path) ?? [];
    if (new Set(finding.files).size !== finding.files.length || paths.length !== finding.files.length
      || new Set(paths).size !== paths.length || finding.files.some((path) => !paths.includes(path))) invalid(`${location}.per_file_necessity must justify each entry in files exactly once using matching paths.`);
  }
}

// Requires evidence references to carry actual bounded text, not blank or malformed values.
function references(value) { return Array.isArray(value) && value.length > 0 && value.every(text); }

// Protects untrusted verdict parsing from type errors masquerading as valid guidance.
function text(value) { return typeof value === "string" && value.trim().length > 0; }

// Keeps malformed guidance in the Reviewer operational failure path, never the Coder repair path.
function invalid(message) { throw Object.assign(new ConfigurationError(message), { code: "REVIEW_VERDICT_INVALID" }); }

// Schema-validated Architecture Plan JSON contract owned by Node.
// Business purpose: only the Architecture Manager's JSON supplies plan content;
// Node validates it against the Architecture Plan schema, merges RFC 7396
// patches deterministically, and renders identical Markdown bytes from the
// canonical JSON so every revision is reproducible and reviewable before
// human approval. The rendered Markdown satisfies the unchanged gates in
// owner-chat-command-service (Plan heading, sections 1 and 7, discovery
// statement, assumptions) and the section-5 outcome table readable by
// markdown-sprint-scope without modification. Owner decision records remain
// appended only through the existing Node-authoritative appendArchitectureDecisions.
// Technical description: parseArchitecturePlanJSON is fail-closed on malformed
// JSON, root arrays, null-bearing required fields and unknown shapes;
// canonicalization sorts keys recursively so object-key insertion order never
// changes bytes or hashes.
import { createHash } from "node:crypto";
import { applyRfc7396MergePatch } from "../../shared/rfc7396-merge-patch.js";
import { appendArchitectureDecisions, decisionError, readArchitectureDecisions } from "./architecture-owner-decisions.js";

const SHA256 = /^[a-f0-9]{64}$/;
/** Shares source and outcome identity rules with the discoverable plan contract. */
const OUTCOME_ID = /^O[1-9][0-9]*$/;
/** Restricts evidence to project source areas accepted by canonical plan validation. */
const SOURCE_EVIDENCE_PATH = /^(?:backend|schemas|ui|web|docs|workflows)\/[A-Za-z0-9._/-]+$/;

// Architecture Plan JSON schema: the only shape AM plan answers may take.
export const ARCHITECTURE_PLAN_JSON_SCHEMA = Object.freeze({
  $id: "https://nodeforge.local/schemas/architecture-plan.schema.json",
  schema_version: 1,
  additionalProperties: false,
  required: ["title", "objective", "background", "scope", "outcomes", "evidence", "assumptions", "constraints", "risks", "verification"],
  fields: {
    title: { type: "string", max: 200, description: "Short outcome-oriented plan title without line breaks." },
    objective: { type: "string", max: 4000, description: "Problem solved, observable target result and business value." },
    background: { type: "string", max: 8000, description: "Current system context, root cause and reason for the change." },
    scope: { type: "string-list", min: 1, max: 40, itemMax: 1000, description: "Explicit In scope: and Out of scope: boundaries (at least 1 non-empty item)." },
    outcomes: { type: "outcome-list", min: 1, max: 20, item: {
      id: { type: "string", pattern: OUTCOME_ID.source, unique: true, description: "Unique outcome identifier O1, O2, ..." },
      outcome: { type: "nonempty-string", description: "Required architecture-level deliverable result." },
      acceptance_criteria: { type: "nonempty-string-list", min: 1, description: "Observable behavior, contract or verification criteria proving the outcome." },
      guardrails: { type: "nonempty-string-list", min: 1, description: "Mandatory boundaries and prerequisite outcome IDs (include 'O1' as a separate item when depending on O1)." } } },
    evidence: { type: "evidence-list", min: 1, max: 60, item: {
      path: { type: "string", pattern: SOURCE_EVIDENCE_PATH.source, description: "Relative source path under backend/, schemas/, ui/, web/, docs/ or workflows/." },
      fact: { type: "nonempty-string", description: "Concrete technical fact verified by reading the source file." },
      location: { optional: true, type: "string", max: 1000, pattern: "^L[1-9][0-9]*(?:[-–—]L?[1-9][0-9]*)?(?:;\\s*L[1-9][0-9]*(?:[-–—]L?[1-9][0-9]*)?)*$", description: "Positive ascending source line ranges, e.g. L17-L75; L98–106. Never prose." } } },
    assumptions: { type: "string-list", min: 1, max: 40, itemMax: 1000, description: "Explicit unverified assumptions or delegated Sprint Leader boundaries (at least 1 non-empty item)." },
    constraints: { type: "string-list", min: 0, max: 40, itemMax: 1000, description: "Global contract, data, security or compatibility constraints and optional delivery guidance." },
    risks: { type: "string-list", min: 0, max: 40, itemMax: 1000, description: "Identified risks with severity, impact and mitigation or decision owner." },
    verification: { type: "string", max: 4000, description: "Plan-level verification strategy that Sprint Leader tickets must cover." }
  },
  update_patch_contract: {
    format: "RFC 7396 JSON Merge Patch",
    description: "When updating an existing plan revision, return a JSON object containing only changed fields; omit unchanged fields, never set any required root field to null, and replace modified arrays in full."
  }
});

// Extracts a single JSON payload from either raw JSON text or one final fenced JSON block.
// Business purpose: allows the Architecture Manager to return a single clean ```json ... ```
// code fence (matching phase-1 clarification discovery) without failing closed on valid JSON,
// while still rejecting prose-only answers, multiple fences or trailing text after the fence.
// Technical description: inspects markdown fence boundaries; if exactly one unlabeled or json
// fence ends the response, returns its inner text; otherwise returns the trimmed raw string.
function extractJsonObjectPayload(raw, emptyMessage) {
  const text = String(raw ?? "").trim();
  if (!text) throw planJsonError(emptyMessage, null);
  const fences = [...text.matchAll(/^```([^\r\n]*)\r?\n([\s\S]*?)^```[ \t]*(?:\r?\n|$)/gm)];
  if (!fences.length) return text;
  const [fence] = fences;
  if (fences.length !== 1 || !["", "json"].includes(fence[1].trim().toLowerCase()) || text.slice(fence.index + fence[0].length).trim()) {
    throw planJsonError("Architecture must return one unambiguous JSON object.", null);
  }
  const payload = fence[2].trim();
  if (!payload) throw planJsonError(emptyMessage, null);
  return payload;
}

// Parses one AM response into a validated Architecture Plan JSON object or fails without partial state.
export function parseArchitecturePlanJSON(raw) {
  const text = extractJsonObjectPayload(raw, "Architecture returned no plan JSON.");
  let value;
  try { value = JSON.parse(text); }
  catch (error) { throw planJsonError(`Architecture plan JSON is malformed: ${error.name}.`, error); }
  if (value === null || Array.isArray(value) || typeof value !== "object") throw planJsonError("A plan response must be a single JSON object.", null);
  assertPlanSchema(value);
  return sortPlanValue(structuredClone(value));
}

// Merges one RFC 7396 patch into the retained canonical base and revalidates the full result.
export function mergeArchitecturePlanJSON(baseJson, patchJson) {
  const base = parseArchitecturePlanJSON(baseJson);
  const trimmed = extractJsonObjectPayload(patchJson, "A plan patch must not be empty.");
  let patch;
  try { patch = JSON.parse(trimmed); }
  catch (error) { throw planJsonError("Architecture plan patch JSON is malformed.", error); }
  if (patch === null || Array.isArray(patch) || typeof patch !== "object") throw planJsonError("A plan patch must be a JSON object.", null);
  for (const field of ARCHITECTURE_PLAN_JSON_SCHEMA.required) {
    if (Object.hasOwn(patch, field) && patch[field] === null) throw planJsonError(`Plan field ${field} cannot be deleted by null.`, null);
  }
  const merged = applyRfc7396MergePatch(base, patch);
  assertPlanSchema(merged);
  return sortPlanValue(merged);
}

// Serializes the validated plan to canonical bytes so identical content always hashes identically.
export function canonicalizeArchitecturePlanJSON(plan) {
  return JSON.stringify(sortPlanValue(structuredClone(plan)));
}

// Computes the canonical bytes SHA-256 Node records as the revision source checksum.
export function canonicalArchitecturePlanSha256(plan) {
  return createHash("sha256").update(canonicalizeArchitecturePlanJSON(plan)).digest("hex");
}

// Renders deterministic Markdown from validated plan JSON plus Node's own identity block.
export function renderArchitecturePlanMarkdown({ plan, planId, revision, sourceSha256 }) {
  assertPlanSchema(plan);
  if (!/^PLAN-[A-Za-z0-9._-]+$/.test(planId ?? "") || !Number.isSafeInteger(revision) || revision < 1 || !SHA256.test(sourceSha256 ?? "")) throw decisionError("ARCHITECTURE_PLAN_RENDER_INVALID", "Rendering needs the exact Node-owned plan identity and source checksum.");
  const evidence = plan.evidence.map((entry) => `- [Evidence: ${entry.path}${entry.location ? `#${entry.location}` : ""}] ${entry.fact}`).join("\n");
  const outcomes = plan.outcomes.map((outcome) => `| ${[outcome.id, outcome.outcome, outcome.acceptance_criteria.join("; "), outcome.guardrails.join("; ")].map(escapePlanTableCell).join(" | ")} |`).join("\n");
  const constraintLines = [...plan.constraints.map((item) => `- Constraint: ${item}`), ...plan.risks.map((item) => `- Risk: ${item}`)];
  const sections = [
    `# Plan: ${plan.title}`,
    `## 1. Objective\n\n${plan.objective}`,
    `## 2. Background\n\n${plan.background}`,
    `## 3. Scope\n\n${plan.scope.map((item) => `- ${item}`).join("\n")}`,
    `## 4. Constraints and risks\n\n${constraintLines.join("\n") || "- None recorded beyond the stated assumptions."}`,
    `## 5. Outcomes\n\n| Outcome | Result | Acceptance | Guardrails |\n| --- | --- | --- | --- |\n${outcomes}`,
    `## 6. Verification\n\n${plan.verification}\n\nRepository discovery complete: every statement above cites a repository file that was actually read.`,
    `## 7. Evidence and assumptions\n\n${evidence}\n\n${plan.assumptions.map((item) => `- Assumption (unverified): ${item}`).join("\n")}\n\nplan_id: ${planId}; revision: r${revision}; source_sha256: ${sourceSha256}`
  ];
  return `${sections.join("\n\n")}\n`;
}

// Keeps valid JSON requirements inside one Markdown cell so literal alternatives cannot
// become extra scope columns. Existing escapes and code delimiters retain their meaning;
// embedded line breaks render inside the cell rather than starting another table row.
function escapePlanTableCell(value) {
  let codeDelimiter = 0;
  return String(value).replace(/\r\n|\r|\n/g, "<br>").replace(/(`+)|(\\*)\|/g, (match, ticks, slashes) => {
    if (ticks) {
      if (!codeDelimiter) codeDelimiter = ticks.length;
      else if (codeDelimiter === ticks.length) codeDelimiter = 0;
      return ticks;
    }
    return codeDelimiter || slashes.length % 2 ? match : `${slashes}\\|`;
  });
}

// Rebuilds one Node session view from an authoritative owner-decision record.
// Technical description: converts the embedded nodeforge-owner-decisions record back into
// the questions/selections/notes shape appendArchitectureDecisions consumes, so a later
// revision or an integrity check reproduces the exact same decision bytes.
export function architectureSessionFromRecord(record) {
  if (!record || !Array.isArray(record.decisions)) throw decisionError("ARCHITECTURE_DECISIONS_INVALID", "Only Node's authoritative owner-decision record can rebuild the planning session.");
  return {
    session_id: record.session_id, source_path: record.source_path, source_sha256: record.source_sha256, owner_id: record.owner_id, confirmed_at: record.confirmed_at,
    questions: record.decisions.map((entry) => ({ id: entry.id, title: entry.title, reason: entry.reason, options: [{ id: entry.option_id, label: entry.label, description: entry.description }] })),
    selections: Object.fromEntries(record.decisions.map((entry) => [entry.id, entry.option_id])),
    notes: Object.fromEntries(record.decisions.filter((entry) => entry.owner_note).map((entry) => [entry.id, entry.owner_note]))
  };
}

// Rebuilds the JSON base of a stored revision from its retained canonical source bytes.
// Technical description: verifies the recorded SHA-256, re-parses and re-renders the plan,
// re-appends the embedded owner-decision record, and compares exact bytes so callers can
// prove the locked revision is reproducible; a tampered snapshot fails this gate.
export function reconstructPlanFromCanonicalSource({ canonicalBytes, sourceSha256, markdown, planId, revision }) {
  if (createHash("sha256").update(String(canonicalBytes)).digest("hex") !== sourceSha256) throw decisionError("PLAN_SOURCE_MISMATCH", "Canonical plan source differs from the recorded revision checksum.");
  const parsed = parseArchitecturePlanJSON(canonicalBytes);
  const rendered = renderArchitecturePlanMarkdown({ plan: parsed, planId, revision, sourceSha256 });
  const record = readArchitectureDecisions(markdown);
  const bytes = `${(record ? appendArchitectureDecisions(rendered, architectureSessionFromRecord(record)) : rendered).trim()}\n`;
  if (bytes !== markdown) throw decisionError("PLAN_HASH_MISMATCH", "Rendered Markdown differs from the locked revision bytes.");
  return parsed;
}

// Creates the stable fail-closed planning error that guarantees no revision was written.
function planJsonError(message, cause) {
  const failure = decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `${message} No revision was created.`);
  if (cause) failure.cause = cause;
  return failure;
}

// Enforces every required field, bounded text and structural uniqueness of the plan schema.
function assertPlanSchema(plan) {
  if (Object.keys(plan).some((field) => !Object.hasOwn(ARCHITECTURE_PLAN_JSON_SCHEMA.fields, field))) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", "A plan answer contains an unknown field, so its meaning is ambiguous. No revision was created.");
  if (Object.keys(plan).some((field) => plan[field] === null)) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", "A required plan field must not be null. No revision was created.");
  for (const field of ARCHITECTURE_PLAN_JSON_SCHEMA.required) validatePlanField(plan, field);
  validateOutcomes(plan.outcomes);
  validateEvidence(plan.evidence);
}

// Validates one schema field against its declared type and bounds.
function validatePlanField(plan, field) {
  const spec = ARCHITECTURE_PLAN_JSON_SCHEMA.fields[field];
  const value = plan[field];
  if (spec.type === "string") {
    if (typeof value !== "string" || !value.trim() || value.length > spec.max) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `Plan field ${field} must be a bounded non-empty string. No revision was created.`);
    return;
  }
  if (spec.type === "string-list") {
    if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max || value.some((item) => typeof item !== "string" || !item.trim() || item.length > spec.itemMax)) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `Plan field ${field} needs bounded non-empty strings. No revision was created.`);
    return;
  }
  if (!Array.isArray(value) || value.length < spec.min || value.length > spec.max) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `Plan field ${field} needs a bounded array. No revision was created.`);
}

// Requires unique O-ids with concrete result, acceptance criteria and guardrails for section 5.
function validateOutcomes(outcomes) {
  const ids = new Set();
  for (const outcome of outcomes) {
    if (!outcome || Array.isArray(outcome) || typeof outcome !== "object" || !OUTCOME_ID.test(outcome.id ?? "") || ids.has(outcome.id)
      || typeof outcome.outcome !== "string" || !outcome.outcome.trim()
      || !Array.isArray(outcome.acceptance_criteria) || !outcome.acceptance_criteria.length || outcome.acceptance_criteria.some((item) => typeof item !== "string" || !item.trim())
      || !Array.isArray(outcome.guardrails) || !outcome.guardrails.length || outcome.guardrails.some((item) => typeof item !== "string" || !item.trim())) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", "Each plan outcome needs a unique O-id, a result, acceptance criteria and guardrails. No revision was created.");
    ids.add(outcome.id);
  }
}

// Requires each evidence entry to name a real project area path and a concrete fact.
function validateEvidence(evidence) {
  for (const [index, entry] of evidence.entries()) {
    if (!entry || Array.isArray(entry) || typeof entry !== "object" || !SOURCE_EVIDENCE_PATH.test(entry.path ?? "")
      || typeof entry.fact !== "string" || !entry.fact.trim()) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `Plan evidence[${index}] needs a project source path and a concrete fact. No revision was created.`);
    if (entry.location !== undefined && !validEvidenceLocation(entry.location)) throw decisionError("ARCHITECTURE_PLAN_JSON_INVALID", `Plan evidence[${index}].location must identify source lines, for example L17-L75 or L17–75; L98–106. No revision was created.`);
  }
}

// Accepts precise source citations containing one or several line ranges without
// discarding the AM's original coordinates or rejecting typographic range dashes.
// Each range must address positive lines in ascending order; prose is never a location.
function validEvidenceLocation(location) {
  if (typeof location !== "string" || location.length > 1000) return false;
  return location.split(/;\s*/).every((range) => {
    const match = /^L([1-9][0-9]*)(?:[-–—]L?([1-9][0-9]*))?$/.exec(range);
    return Boolean(match && Number.isSafeInteger(Number(match[1])) && (!match[2] || Number.isSafeInteger(Number(match[2])) && Number(match[2]) >= Number(match[1])));
  });
}

// Sorts object keys recursively so identical plans always share one canonical representation.
function sortPlanValue(value) {
  if (Array.isArray(value)) return value.map(sortPlanValue);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortPlanValue(value[key])]));
  return value;
}

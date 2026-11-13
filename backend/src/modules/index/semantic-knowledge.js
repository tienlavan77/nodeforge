/**
 * Project-scoped semantic retrieval knowledge keeps verified query anchors and
 * feedback in Git-managed source files while treating Forge runtime indexes as
 * disposable caches. Records are accepted only with project identity, source
 * revision and an independent verifier so ranking can reuse evidence without
 * turning relevance scores into business correctness.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize, relative, resolve } from "node:path";

const KNOWLEDGE_FILES = Object.freeze({
  golden_queries: "vocabulary/semantic-evaluation/golden-queries.jsonl",
  retrieval_feedback: "vocabulary/retrieval-feedback.jsonl",
  semantic_anchors: "vocabulary/semantic-anchors.jsonl"
});
const APPROVED_VERIFIERS = new Set(["reviewer", "owner", "test", "verification", "system_engineer"]);
const LABELS = new Set(["accepted", "rejected", "unknown"]);
const STATUSES = new Set(["approved", "observational", "quarantined"]);

/**
 * Produces a stable query identity so records remain portable across runtime
 * restarts and can be compared without trusting provider-specific embeddings.
 */
export function fingerprintQuery(input = {}) {
  const value = [input.title, input.objective, input.query, input.source, ...(input.acceptance_criteria ?? []), ...(input.guardrails ?? [])]
    .filter((item) => typeof item === "string" && item.trim())
    .map((item) => item.trim().replace(/\s+/g, " ").toLowerCase())
    .join("\n");
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * Validates one project knowledge record and returns a normalized immutable
 * record, allowing callers to quarantine invalid data without affecting search.
 */
export function validateKnowledgeRecord(record, { projectId, kind = "retrieval_feedback", projectRoot = null, sourceReader = null, sourceRevision = null } = {}) {
  const errors = [];
  const candidates = record?.accepted_symbols ?? record?.candidate ?? record?.expected_symbols;
  const candidateList = Array.isArray(candidates) ? candidates : candidates ? [candidates] : [];
  if (projectRoot && candidateList.some((item) => !isContainedProjectPath(projectRoot, item?.path))) errors.push("candidate path is outside project corpus");
  if (!record || typeof record !== "object" || Array.isArray(record)) return { valid: false, errors: ["record must be an object"] };
  if (record.project_id !== projectId) errors.push("project_id mismatch");
  if (typeof record.query_fingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.query_fingerprint)) errors.push("query_fingerprint is invalid");
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
  const strings = (value) => Array.isArray(value) && value.every(nonempty);
  if (![record.title, record.objective, record.query].some(nonempty)) errors.push("canonical query fields are required");
  if (record.acceptance_criteria !== undefined && !strings(record.acceptance_criteria)) errors.push("acceptance_criteria must be a string array");
  if (record.guardrails !== undefined && !strings(record.guardrails)) errors.push("guardrails must be a string array");
  if (strings(record.acceptance_criteria ?? []) && strings(record.guardrails ?? []) && record.query_fingerprint !== fingerprintQuery(record)) errors.push("query_fingerprint does not match canonical query");
  if (kind === "golden_queries") {
    if (!nonempty(record.objective)) errors.push("golden objective is required");
    if (!strings(record.acceptance_criteria) || !record.acceptance_criteria.length) errors.push("golden acceptance_criteria are required");
    if (!strings(record.guardrails)) errors.push("golden guardrails are required");
    for (const field of ["expected_symbols", "acceptable_alternatives", "known_false_positives"]) {
      if (!Array.isArray(record[field]) || (field === "expected_symbols" && !record[field].length)
        || record[field].some((item) => !nonempty(item?.path) || !nonempty(item?.symbol) || !isContainedProjectPath(projectRoot, item.path))) errors.push(`golden ${field} must contain project path-symbol pairs`);
    }
    if (!nonempty(record.verifier_provenance?.evidence) || !nonempty(record.verifier_provenance?.revision)
      || record.verifier_provenance?.verifier !== (record.verifier ?? record.verified_by)) errors.push("golden verifier_provenance is required");
  }
  if (!record.source_revision && !record.source_sha256) errors.push("source_revision or source_sha256 is required");
  if (record.source_sha256 !== undefined && (typeof record.source_sha256 !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.source_sha256))) errors.push("source_sha256 is invalid");
  if (record.source_revision !== undefined && (typeof record.source_revision !== "string" || !record.source_revision.trim())) errors.push("source_revision is invalid");
  if (sourceRevision && record.source_revision && record.source_revision !== sourceRevision) errors.push("source_revision mismatch");
  const verifier = record.verifier ?? record.verified_by;
  if (!APPROVED_VERIFIERS.has(verifier)) errors.push("verifier provenance is not approved");
  if (kind === "semantic_anchor" && !STATUSES.has(record.status)) errors.push("anchor status is invalid");
  if (kind === "retrieval_feedback" && !LABELS.has(record.label)) errors.push("feedback label is invalid");
  if (!candidateList.length) errors.push("path or symbol evidence is required");
  for (const item of candidateList) {
    if (!item || typeof item.path !== "string" || !item.path || item.path.includes("..") || item.path.startsWith("/")) errors.push("candidate path is invalid");
    if (item?.symbol !== undefined && (typeof item.symbol !== "string" || !item.symbol.trim())) errors.push("candidate symbol is invalid");
  }
  if (sourceReader !== null && typeof sourceReader !== "function") errors.push("corpus source validation is unavailable");
  return errors.length ? { valid: false, errors } : { valid: true, record: Object.freeze({ ...record, verifier }) };
}

/**
 * Loads newline-delimited project knowledge with deterministic ordering,
 * duplicate suppression and explicit diagnostics for malformed or stale data.
 */
export async function loadProjectKnowledge({ projectRoot, projectId, sourceRevision = null, logger = console, sourceReader = null } = {}) {
  if (typeof projectRoot !== "string" || typeof projectId !== "string" || !projectId) throw new TypeError("projectRoot and projectId are required");
  const records = { golden_queries: [], retrieval_feedback: [], semantic_anchors: [] };
  const diagnostics = { loaded: 0, rejected: 0, duplicates: 0, stale: 0, source_mismatch: 0, rejections: [], files: KNOWLEDGE_FILES };
  const reject = (path, line, errors) => { diagnostics.rejected++; diagnostics.rejections.push({ path, line, errors }); };
  const seen = new Set();
  for (const [kind, relativePath] of Object.entries(KNOWLEDGE_FILES)) {
    const path = join(projectRoot, relativePath);
    let text;
    try { text = await readFile(path, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      logger.warn?.("Semantic knowledge file could not be read.", { path: relativePath, error: error.message });
      diagnostics.rejected++;
      continue;
    }
    for (const [lineNumber, line] of text.split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      let parsed;
      try { parsed = JSON.parse(line); }
      catch (error) {
        logger.warn?.("Semantic knowledge record is malformed.", { path: relativePath, line: lineNumber + 1, error: error.message });
        diagnostics.rejected++;
        continue;
      }
      const validation = validateKnowledgeRecord(parsed, { projectId, kind: kind === "semantic_anchors" ? "semantic_anchor" : kind, projectRoot, sourceReader, sourceRevision });
      if (!validation.valid) { reject(relativePath, lineNumber + 1, validation.errors); continue; }
      const identity = JSON.stringify([kind, parsed.query_fingerprint, parsed.path ?? parsed.candidate?.path, parsed.symbol ?? parsed.candidate?.symbol, parsed.label, parsed.status]);
      if (seen.has(identity)) { diagnostics.duplicates++; reject(relativePath, lineNumber + 1, ["duplicate feedback identity"]); continue; }
      seen.add(identity);
      if (sourceRevision && parsed.source_revision && parsed.source_revision !== sourceRevision) { diagnostics.stale++; continue; }
      let corpusValidated = false;
      if (sourceReader) {
        const items = parsed.accepted_symbols ?? parsed.candidate ?? parsed.expected_symbols;
        const sourceItems = Array.isArray(items) ? items : [items];
        let sourceValid = true;
        for (const item of sourceItems) {
          const source = await sourceReader(item.path);
          if (!source || (parsed.source_sha256 && source.sha256 !== parsed.source_sha256) || (parsed.source_revision && source.source_revision !== parsed.source_revision) || (item.symbol && !source.symbol_map?.some((symbol) => symbol.name === item.symbol))) { sourceValid = false; break; }
        }
        if (!sourceValid) { diagnostics.source_mismatch++; reject(relativePath, lineNumber + 1, ["current corpus source identity or symbol mismatch"]); continue; }
        corpusValidated = true;
      }
      if (parsed.status === "quarantined" || parsed.label === "unknown") continue;
      records[kind].push(Object.freeze({ ...validation.record, corpus_validated: corpusValidated, corpus_validation: { source_revision: sourceRevision, verifier: parsed.verifier ?? parsed.verified_by ?? null } }));
      diagnostics.loaded++;
    }
  }
  for (const list of Object.values(records)) list.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return Object.freeze({ project_id: projectId, records: Object.freeze(records), diagnostics: Object.freeze(diagnostics) });
}

/**
 * Applies bounded, explainable project feedback to already scope- and receipt-
 * validated candidates. Unknown or invalid knowledge leaves baseline ordering intact.
 */
export function rerankCandidates(candidates = [], knowledge, { queryFingerprint, maxAdjustment = 0.15, maxTotalAdjustment = 0.3, maxAdjustedCandidates = 2, projectId = null, receiptValidator = null } = {}) {
  const feedback = (knowledge?.records?.retrieval_feedback ?? []).filter((item) => item.corpus_validated === true);
  const anchors = (knowledge?.records?.semantic_anchors ?? []).filter((item) => item.corpus_validated === true);
  const hardCap = 0.15;
  const cap = Math.min(hardCap, Math.max(0, Number(maxAdjustment) || 0));
  const identityMatches = (record, candidate) => {
    const source = candidate?.source_sha256 ?? candidate?.sha256 ?? candidate?.receipt?.sha256;
    const revision = candidate?.source_revision ?? candidate?.receipt?.source_revision;
    const item = record?.candidate ?? record;
    if (!item || item.path !== candidate?.path) return false;
    if (item.symbol !== undefined && item.symbol !== candidate?.symbol) return false;
    if (item.source_sha256 !== undefined && item.source_sha256 !== source) return false;
    if (item.source_revision !== undefined && item.source_revision !== revision) return false;
    if (!projectId || record.project_id !== projectId) return false;
    if (record.source_sha256 && record.source_sha256 !== source) return false;
    if (record.source_revision && record.source_revision !== revision) return false;
    const binding = record.receipt_binding;
    if (!binding || binding.receipt_id !== candidate.receipt_id || binding.source_revision !== revision
      || JSON.stringify(binding.scope) !== JSON.stringify(candidate.scope)
      || JSON.stringify(binding.execution_identity) !== JSON.stringify(candidate.execution_identity)) return false;
    return true;
  };
  const adjustment = (candidate) => {
    if (candidate?.receipt?.status !== "verified" || candidate?.fresh !== true || typeof receiptValidator !== "function" || !receiptValidator(candidate)) return { value: 0, reasons: ["knowledge:not_applied_unverified_candidate"] };
    if (!candidate?.path || !queryFingerprint) return { value: 0, reasons: ["knowledge:not_applied_missing_identity"] };
    const accepted = anchors.some((item) => item.query_fingerprint === queryFingerprint && (item.accepted_symbols ?? []).some((symbol) => identityMatches({ ...item, candidate: symbol }, candidate)))
      || feedback.some((item) => item.query_fingerprint === queryFingerprint && item.label === "accepted" && identityMatches(item, candidate));
    const rejected = feedback.some((item) => item.query_fingerprint === queryFingerprint && item.label === "rejected" && identityMatches(item, candidate));
    if (accepted && !rejected) return { value: cap, reasons: ["knowledge:accepted"] };
    if (rejected) return { value: -cap, reasons: ["knowledge:rejected"] };
    return { value: 0, reasons: [] };
  };
  let remaining = Math.min(0.3, Math.max(0, Number(maxTotalAdjustment) || 0));
  let adjusted = 0;
  const seenCandidates = new Set();
  const ranked = candidates.map((candidate, index) => {
    const identity = JSON.stringify([candidate.path, candidate.symbol ?? null]);
    const result = adjustment(candidate);
    if (seenCandidates.has(identity) || adjusted >= Math.min(2, Math.max(0, maxAdjustedCandidates))) result.value = 0;
    result.value = Math.sign(result.value) * Math.min(Math.abs(result.value), remaining);
    if (result.value) { remaining -= Math.abs(result.value); adjusted++; }
    seenCandidates.add(identity);
    return { ...candidate, baseline_score: Number(candidate.score ?? 0), score: Number((Number(candidate.score ?? 0) + result.value).toFixed(6)), knowledge_adjustment: result.value, reasons: [...(candidate.reasons ?? []), ...result.reasons], baseline_rank: index + 1 };
  });
  if (!ranked.some((candidate) => candidate.knowledge_adjustment !== 0)) return ranked;
  return ranked.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || String(a.symbol ?? "").localeCompare(String(b.symbol ?? "")) || a.baseline_rank - b.baseline_rank);
}

function isContainedProjectPath(projectRoot, candidatePath) {
  if (typeof projectRoot !== "string" || typeof candidatePath !== "string" || !candidatePath || candidatePath.startsWith("/")) return false;
  const root = resolve(projectRoot);
  const target = resolve(root, candidatePath);
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${normalize("/")}`) && !target.includes("\0"));
}

// Verifies strict golden labels, actionable quarantine diagnostics and bounded feedback.
// These deterministic fixtures prove validation contracts, not live-role acceptance or ranking gains.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintQuery, validateKnowledgeRecord, loadProjectKnowledge, rerankCandidates } from "../../src/modules/index/semantic-knowledge.js";
import { evaluateRetrievalCases } from "../eval/retrieval-metrics.js";

/** Builds independently labelled query fields with complete source and verifier provenance. */
function golden() {
  const record = { project_id: "project", objective: "Find example behavior", acceptance_criteria: ["example returns a value"], guardrails: [],
    expected_symbols: [{ path: "backend/src/example.js", symbol: "example" }], acceptable_alternatives: [], known_false_positives: [],
    source_revision: "a".repeat(40), verifier: "test", verifier_provenance: { verifier: "test", evidence: "fixture:example", revision: "a".repeat(40) } };
  return { ...record, query_fingerprint: fingerprintQuery(record) };
}

test("golden query schema rejects absent or malformed fields and fabricated fingerprints", () => {
  const options = { projectId: "project", projectRoot: process.cwd(), kind: "golden_queries" };
  assert.equal(validateKnowledgeRecord(golden(), options).valid, true);
  for (const field of ["objective", "acceptance_criteria", "guardrails", "expected_symbols", "acceptable_alternatives", "known_false_positives", "verifier_provenance"]) {
    const value = golden(); delete value[field];
    assert.equal(validateKnowledgeRecord(value, options).valid, false, field);
  }
  assert.equal(validateKnowledgeRecord({ ...golden(), query_fingerprint: "sha256:" + "0".repeat(64) }, options).valid, false);
  assert.equal(validateKnowledgeRecord({ ...golden(), guardrails: "not an array" }, options).valid, false);
});

test("rejected records retain file, line and actionable validation reasons", async () => {
  const root = await mkdtemp(join(tmpdir(), "round-two-knowledge-"));
  try {
    await mkdir(join(root, "vocabulary/semantic-evaluation"), { recursive: true });
    await writeFile(join(root, "vocabulary/semantic-evaluation/golden-queries.jsonl"), JSON.stringify({ ...golden(), objective: undefined }));
    const result = await loadProjectKnowledge({ projectRoot: root, projectId: "project" });
    assert.equal(result.diagnostics.rejected, 1);
    assert.equal(result.diagnostics.rejections[0].line, 1);
    assert.ok(result.diagnostics.rejections[0].errors.includes("golden objective is required"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("reranking requires private receipt validation and exact lineage, caps duplicates and aggregate", () => {
  const candidates = [0, 1, 2, 3].map((i) => ({ path: `backend/src/e${i}.js`, symbol: "example", score: 1,
    sha256: "sha256:" + "b".repeat(64), source_revision: "a".repeat(40), receipt_id: `receipt:${i}`, receipt: { status: "verified" }, fresh: true,
    scope: { allowed_file_paths: ["backend/src"], allowed_prefixes: [] }, execution_identity: { execution_id: "run" } }));
  const feedback = candidates.map((candidate) => ({ ...golden(), label: "accepted", corpus_validated: true, candidate: { path: candidate.path, symbol: candidate.symbol },
    receipt_binding: { receipt_id: candidate.receipt_id, source_revision: candidate.source_revision, scope: candidate.scope, execution_identity: candidate.execution_identity } }));
  const knowledge = { records: { retrieval_feedback: [...feedback, ...feedback] } };
  const options = { queryFingerprint: golden().query_fingerprint, projectId: "project", receiptValidator: () => true };
  const ranked = rerankCandidates([...candidates, candidates[0]], knowledge, options);
  assert.ok(ranked.reduce((sum, item) => sum + Math.abs(item.knowledge_adjustment), 0) <= 0.3);
  assert.equal(ranked.filter((item) => item.knowledge_adjustment).length, 2);
  assert.equal(rerankCandidates(candidates, knowledge, { ...options, receiptValidator: undefined })[0].knowledge_adjustment, 0);
  assert.equal(rerankCandidates([{ ...candidates[0], scope: {} }], knowledge, options)[0].knowledge_adjustment, 0);
});

test("evaluation artifact retains explicit provenance, fallback counts and regression outcomes", () => {
  const report = evaluateRetrievalCases([{ id: "fixture", fallback_reasons: ["missing_knowledge"] }], {
    datasetChecksum: "sha256:" + "a".repeat(64), knowledgeRevision: "knowledge-revision", modelIdentity: "fixture-model", indexIdentity: "fixture-index",
    verifierProvenance: [{ verifier: "test", evidence: "fixture" }], regressionResults: [{ name: "scope", passed: true }] });
  assert.equal(report.provenance_complete, true);
  assert.equal(report.fallback_counts.missing_knowledge, 1);
  assert.equal(report.regression_results[0].passed, true);
  assert.equal(evaluateRetrievalCases([]).provenance_complete, false);
});

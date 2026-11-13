// Business purpose: protects project-scoped semantic knowledge from becoming an unverified ranking authority.
// Technical description: exercises canonical query identity, corpus validation, and baseline-preserving reranking.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintQuery, loadProjectKnowledge, rerankCandidates, validateKnowledgeRecord } from "../../src/modules/index/semantic-knowledge.js";

const query = { title: "Receipt retrieval", objective: "Find verified source", acceptance_criteria: ["Read the symbol"], guardrails: ["Stay scoped"] };
const baseRecord = {
  project_id: "project", ...query, query_fingerprint: fingerprintQuery(query), source_revision: "a".repeat(40),
  verifier: "reviewer", label: "accepted", candidate: { path: "backend/src/example.js", symbol: "example", source_revision: "a".repeat(40) }
};

test("knowledge validation rejects a non-canonical query fingerprint and outside path", () => {
  const result = validateKnowledgeRecord({ ...baseRecord, query_fingerprint: "sha256:" + "0".repeat(64), candidate: { path: "../secret.js" } }, { projectId: "project", projectRoot: process.cwd() });
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("query_fingerprint does not match canonical query"));
  assert.ok(result.errors.includes("candidate path is outside project corpus"));
});

test("knowledge loaded without a source reader is not eligible for reranking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "semantic-knowledge-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(`${root}/vocabulary`, { recursive: true });
  await writeFile(`${root}/vocabulary/retrieval-feedback.jsonl`, `${JSON.stringify(baseRecord)}\n`);
  const knowledge = await loadProjectKnowledge({ projectRoot: root, projectId: "project" });
  assert.equal(knowledge.records.retrieval_feedback[0].corpus_validated, false);
  const [ranked] = rerankCandidates([{ path: "backend/src/example.js", score: 1, sha256: "sha256:x", source_revision: baseRecord.source_revision, fresh: true, receipt: { status: "verified" } }], knowledge, { queryFingerprint: baseRecord.query_fingerprint, projectId: "project" });
  assert.equal(ranked.score, 1);
  assert.equal(ranked.knowledge_adjustment, 0);
});

test("reranking requires source identity in corpus-validated knowledge", () => {
  const knowledge = { records: { retrieval_feedback: [{ ...baseRecord, corpus_validated: true }] } };
  const candidate = { path: "backend/src/example.js", score: 1, sha256: "sha256:" + "1".repeat(64), source_revision: baseRecord.source_revision, fresh: true, receipt: { status: "verified" } };
  const [ranked] = rerankCandidates([candidate], knowledge, { queryFingerprint: baseRecord.query_fingerprint, projectId: "project" });
  assert.equal(ranked.knowledge_adjustment, 0);
});

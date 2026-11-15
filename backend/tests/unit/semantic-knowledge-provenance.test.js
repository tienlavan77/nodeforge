// Business purpose: prevents portable knowledge records from hiding missing revision provenance.
// Technical description: checks each independent identity through direct validation and disk
// loading, including source-reader validation, malformed records and context mismatches.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fingerprintQuery, validateKnowledgeRecord, loadProjectKnowledge } from "../../src/modules/index/semantic-knowledge.js";

const record = {
  project_id: "project", query: "find verified symbol", label: "accepted", verifier: "reviewer",
  candidate: { path: "example.js", symbol: "example" },
  source_revision: "a".repeat(40), knowledge_artifact_revision: "b".repeat(40),
  review_commit_sha: "c".repeat(40), source_sha256: "sha256:" + "d".repeat(64)
};
record.query_fingerprint = fingerprintQuery(record);
const fields = ["source_revision", "knowledge_artifact_revision", "review_commit_sha", "source_sha256"];

test("knowledge identities are mandatory, independently validated and never substituted", () => {
  assert.equal(validateKnowledgeRecord(record, { projectId: "project" }).valid, true);
  for (const field of fields) {
    for (const value of [undefined, null, "", " ", 123, "PENDING_REPAIR_COMMIT", "abc123"]) {
      const result = validateKnowledgeRecord({ ...record, [field]: value }, { projectId: "project" });
      assert.equal(result.valid, false, field + ":" + value);
      assert.ok(result.errors.some((error) => error.includes(field)));
    }
  }
  for (const [field, option] of [["source_revision", "sourceRevision"], ["knowledge_artifact_revision", "knowledgeArtifactRevision"], ["review_commit_sha", "reviewCommitSha"]]) {
    const result = validateKnowledgeRecord(record, { projectId: "project", [option]: "e".repeat(40) });
    assert.ok(result.errors.includes(field + " mismatch"));
  }
});

test("loader rejects omitted or mismatched provenance with and without a source reader", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-provenance-"));
  try {
    await mkdir(join(root, "vocabulary"));
    for (const sourceReader of [null, async () => ({ source_revision: record.source_revision, sha256: record.source_sha256, symbol_map: [{ name: "example" }] })]) {
      for (const field of fields) {
        const absent = { ...record }; delete absent[field];
        await writeFile(join(root, "vocabulary/retrieval-feedback.jsonl"), JSON.stringify(absent));
        const knowledge = await loadProjectKnowledge({ projectRoot: root, projectId: "project", sourceRevision: record.source_revision, sourceReader });
        assert.equal(knowledge.diagnostics.loaded, 0, field);
        assert.equal(knowledge.diagnostics.rejected, 1, field);
        assert.ok(knowledge.diagnostics.rejections[0].errors.some((error) => error.includes(field)));
      }
      for (const option of ["sourceRevision", "knowledgeArtifactRevision", "reviewCommitSha"]) {
        await writeFile(join(root, "vocabulary/retrieval-feedback.jsonl"), JSON.stringify(record));
        const result = await loadProjectKnowledge({ projectRoot: root, projectId: "project", sourceRevision: record.source_revision, sourceReader, [option]: "e".repeat(40) });
        assert.equal(result.diagnostics.loaded, 0);
        assert.equal(result.diagnostics.stale, 1);
      }
      const options = { projectRoot: root, projectId: "project", sourceRevision: record.source_revision, knowledgeArtifactRevision: record.knowledge_artifact_revision, reviewCommitSha: record.review_commit_sha, sourceReader };
      const valid = await loadProjectKnowledge(options);
      assert.equal(valid.diagnostics.loaded, 1);
      assert.equal(valid.records.retrieval_feedback[0].corpus_validated, Boolean(sourceReader));
    }
    await writeFile(join(root, "vocabulary/retrieval-feedback.jsonl"), "null\n[]\n");
    assert.equal((await loadProjectKnowledge({ projectRoot: root, projectId: "project" })).diagnostics.rejected, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

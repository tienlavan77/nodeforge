// Ensures Reviewer validation cannot allocate unpublished IDs into a verdict before durable recording.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";

// Creates an isolated review store bound to the ticket's verified source.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-review-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { review_commit_sha: "a".repeat(40), verification_artifact_id: "ARTIFACT-1", source_revision: "SOURCE-1" };
  const store = createTicketReviewFindingsStore({ taskId: "T", fileService: createFileService({ projectRoot: root }), executionContexts: { load: async () => context } });
  const input = { verdict: "request_changes", artifactId: context.verification_artifact_id, commitSha: context.review_commit_sha, sourceRevision: context.source_revision,
    findings: ["Regex undercounts lines", "Quoted identifiers rejected"].map((failure) => ({ acceptance_criterion: "AC-1", failure, minimum_change_scope: "Repair the verified behavior", evidence_refs: [context.verification_artifact_id] })) };
  return { store, input };
}

for (const direct of [false, true]) {
  test(`validation preserves a new verdict before recording two durable findings (direct=${direct})`, async (t) => {
    const { store, input } = await fixture(t);
    const before = structuredClone(input), durable = await store.load();
    for (let attempt = 0; attempt < 2; attempt++) {
      const preview = direct ? await store.recordReview({ ...input, validateOnly: true }) : await store.validateReview(input);
      assert.deepEqual(preview.findings.map((entry) => entry.finding_id), ["REV-1", "REV-2"]);
      assert.deepEqual(input, before);
      assert.deepEqual(await store.load(), durable);
    }
    await store.recordReview(input);
    assert.deepEqual(input, before, "persisting findings must not inject IDs into caller data");
    const recorded = await store.load();
    assert.deepEqual(recorded.findings.map((entry) => entry.finding_id), ["REV-1", "REV-2"]);
    await store.recordReview(input);
    assert.equal((await store.load()).findings.length, 2);
    const refined = { ...input, findings: [{ ...input.findings[0], finding_id: recorded.findings[0].finding_id, failure: "Refined regex counterexample" }] };
    await store.validateReview(refined);
    await store.recordReview(refined);
    assert.equal((await store.load()).findings[0].message, "Refined regex counterexample");
    await assert.rejects(store.validateReview({ ...input, findings: [{ ...input.findings[0], finding_id: "REV-99" }] }), { code: "REVIEW_FINDINGS_INVALID" });
  });
}

test("rejected validation preserves caller findings and leaves no partially allocated IDs", async (t) => {
  const { store, input } = await fixture(t);
  input.findings[1].finding_id = "REV-99";
  const before = structuredClone(input), durable = await store.load();
  await assert.rejects(store.validateReview(input), { code: "REVIEW_FINDINGS_INVALID" });
  assert.deepEqual(input, before);
  assert.deepEqual(await store.load(), durable);
});

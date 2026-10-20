// Exercises post-integration review against retained commits without running models or changing ticket state.
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAutomaticReviewWorkerResolver } from "../../src/modules/supervisor/automatic-review-source.js";
import { createCommittedReviewSource } from "../../src/modules/supervisor/reviewer-committed-source.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";

const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

// Builds a real immutable Git snapshot while keeping all execution records in memory.
async function fixture({ outsideEvidence = false } = {}) {
  const git = createTicketRootGit({ projectRoot });
  const commit = (await git.run(["rev-parse", "HEAD"])).trim();
  const path = "backend/src/transport/http/server.js";
  const base = (await git.run(["log", "-1", "--format=%P", commit, "--", path])).trim().split(" ")[0];
  const source = createCommittedReviewSource({ projectRoot, commit, baseCommit: base });
  const file = await source.readForIndex({ path });
  const artifact = { artifact_id: "artifact-review", commit_sha: commit, base_sha: base, manifest_sha: "manifest-review", source_revision: "revision-review", changed_paths: [path], file_checksums: { [path]: file.sha256 } };
  const context = { state: "verified", version: 1, verification_artifact_id: artifact.artifact_id, review_commit_sha: commit, base_sha: base, manifest_sha: artifact.manifest_sha, source_revision: artifact.source_revision, manifest_paths: [path] };
  const reviewer = { agent_id: "reviewer", role: "reviewer", enabled: true, status: "ready", provider: "openai" };
  const job = { task_id: "ticket-review", agent_id: "coder", review_policy: { gate: "off" }, review_rules: "Read all evidence independently.", payload: { ticket: {}, verification: artifact, execution_context: context, changed_paths: [path] }, finding_snapshot: { coder_reports: [{ artifact_id: artifact.artifact_id, report: { summary: "Verified changes" } }] } };
  let prompt;
  let tools;
  const workspace = { path: projectRoot, codeSearch: { search: async () => ({ matches: [{ node: { path }, score: 1 }] }) }, gitService: {
    status: async ({ paths }) => { assert.deepEqual(paths, [path]); return ` M ${path}\n`; },
    diffWorkingTree: async ({ paths }) => { assert.deepEqual(paths, [path]); return "working-tree diff, not verified evidence"; }
  } };
  const resolveWorker = createAutomaticReviewWorkerResolver({ resolveTicketWorkspace: async () => workspace, agentResolver: { resolveAvailable: () => reviewer, list: () => [reviewer] }, projectLogger: () => {},
    gateways: { openaiSdkGateway: { execute: async (request) => {
      prompt = request.prompt;
      tools = request.options.forgeTools;
      if (!tools.registry.read_file) {
        assert.deepEqual(tools.definitions, []);
        return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Missing acceptance evidence", acceptance_criterion: "Project isolation", evidence_refs: ["AGENTS.md:1"], minimum_change_scope: "Add isolated retrieval verification" }], adjudications: [] }) };
      }
      assert.equal(tools.registry.review_source, undefined);
      assert.equal(tools.registry.review_diff, undefined);
      const found = await tools.registry.read_file.execute({ path, offset: 1, limit: 5 });
      assert.equal(found.review_evidence.commit_sha, commit);
      assert.equal((await tools.registry.read_file.execute({ path: "AGENTS.md", offset: 1, limit: 5 })).path, "AGENTS.md");
      assert.equal((await tools.registry.git_status.execute({})).changed_files, 1);
      assert.equal((await tools.registry.git_diff.execute({})).stdout, "working-tree diff, not verified evidence");
      const result = await tools.registry.read_lines.execute({ path, start_line: 1, end_line: 5 });
      assert.equal(result.stdout, file.content.split("\n").slice(0, 5).join("\n") + "\n");
      assert.equal(result.review_evidence.commit_sha, commit);
      assert.equal(result.review_evidence.artifact_id, artifact.artifact_id);
      await assert.rejects(() => tools.registry.read_lines.execute({ path, start_line: 1, end_line: 81 }), { code: "READ_LINES_INPUT_INVALID" });
      return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Missing acceptance evidence", acceptance_criterion: "Project isolation", evidence_refs: [outsideEvidence ? "AGENTS.md:1" : `${path}:1`], minimum_change_scope: "Add isolated retrieval verification", per_file_necessity: [{ path, role: "Acceptance test scope" }] }], adjudications: [] }) };
    } } } });
  return { run: async () => (await resolveWorker(job)).review(), getPrompt: () => prompt, getTools: () => tools, path };
}

test("soft review uses existing source tools and receives the committed baseline diff", async () => {
  const review = await fixture();
  const verdict = await review.run();
  assert.equal(verdict.verdict, "request_changes");
  assert.deepEqual(verdict.changed_paths, [review.path]);
  assert.match(review.getPrompt(), /diff --git/);
  assert.doesNotMatch(review.getPrompt(), /<no tracked patch available>/);
  assert.match(review.getPrompt(), /not a "file" key/);
  assert.deepEqual(review.getTools().definitions.map(({ name }) => name), ["search_tree", "list_files", "search_text", "read_file", "read_lines", "git_status", "git_diff"]);
  assert.doesNotMatch(review.getPrompt(), /review_source|review_diff/);
});

test("existing Reviewer tools preserve manifest-bound verdict evidence", async () => {
  const review = await fixture({ outsideEvidence: true });
  await assert.rejects(() => review.run(), { code: "REVIEW_VERDICT_INVALID" });
});

// Verifies automatic Reviewer SDK tools read the exact retained Git revision after completion and root source drift.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { createAutomaticReviewWorkerResolver } from "../../src/modules/supervisor/review/automatic-review-source.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

const execFile = promisify(callback);

// Runs Git only within disposable project-local integration fixtures, never committing the owner repository.
async function fixtureGit(root, ...args) {
  return (await execFile("git", ["-C", root, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1" } })).stdout.trim();
}

// Prepares one committed source artifact and a read-only SDK boundary without using a real provider.
async function sourceFixture() {
  const directory = join(process.cwd(), ".forge/test-tmp");
  await mkdir(directory, { recursive: true });
  const root = await mkdtemp(join(directory, "automatic-source-"));
  const path = "backend/src/total.js";
  const content = "export const total = 1;\n";
  await mkdir(join(root, "backend/src"), { recursive: true });
  await writeFile(join(root, path), content);
  await fixtureGit(root, "init");
  await fixtureGit(root, "add", "backend/src/total.js");
  await fixtureGit(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Verified fixture");
  const commit = await fixtureGit(root, "rev-parse", "HEAD");
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  const artifact = { artifact_id: "ARTIFACT-1", commit_sha: commit, source_revision: 1, manifest_sha: "sha256:manifest", base_sha: commit,
    changed_paths: [path], file_checksums: { [path]: checksum }, status: "passed" };
  const context = { state: "verified", version: 1, source_revision: 1, manifest_sha: artifact.manifest_sha, base_sha: commit, review_commit_sha: commit, verification_artifact_id: artifact.artifact_id, manifest_paths: [path] };
  const exchange = { coder_reports: [{ artifact_id: artifact.artifact_id, report: { summary: "Coder verified total" } }], findings: [], coder_responses: [] };
  const job = { task_id: "TICKET-1", supervisor_id: "SUP-1", request_id: "REVIEW-1", correlation_id: "CORR-1", agent_id: "coder-1", review_rules: "Return canonical approved or request_changes based only on exact source.", review_policy: { gate: "off" },
    finding_snapshot: exchange, payload: { ticket: { id: "TICKET-1", acceptance_criteria: ["Total is one"] }, verification: artifact, execution_context: context, changed_paths: [path], commit, base_commit: commit } };
  const profile = { agent_id: "reviewer-1", enabled: true, status: "ready", role: "reviewer", provider: "openai" };
  const workspace = { path: root, projectRoot: root, executionContexts: { load: async () => context, update: async (taskId, version, patch) => Object.assign(context, patch) },
    testService: { assertPassedArtifact: async () => artifact, assertCleanWorktree: async () => {} }, reviewFindings: { load: async () => exchange },
    worktreeFileService: createFileService({ projectRoot: root }), gitService: { getHead: async () => commit } };
  return { root, path, content, checksum, artifact, context, job, workspace, agentResolver: { resolveAvailable: () => profile, list: () => [profile] } };
}

// Keeps post-completion reads pinned to the old commit even when the root path is modified or removed.
for (const drift of ["modified", "removed"]) {
  test(`soft review uses committed source when completed root file is ${drift}`, async () => {
    const fixture = await sourceFixture();
    try {
      fixture.context.state = "terminal";
      if (drift === "modified") await writeFile(join(fixture.root, fixture.path), "export const total = 999;\n");
      else await rm(join(fixture.root, fixture.path));
      let sdkCalls = 0;
      const resolver = createAutomaticReviewWorkerResolver({ resolveTicketWorkspace: async () => fixture.workspace, agentResolver: fixture.agentResolver,
        gateways: { openaiSdkGateway: { execute: async ({ prompt, options }) => {
          sdkCalls += 1;
          assert.match(prompt, /export const total = 1;/);
          assert.doesNotMatch(prompt, /total = 999/);
          assert(options.forgeTools.definitions.some((tool) => tool.name === "read_lines"));
          assert(!options.forgeTools.definitions.some((tool) => ["write_diff", "report_done", "commit_changes"].includes(tool.name)));
          const result = await options.forgeTools.registry.read_lines.execute({ path: fixture.path, start_line: 1, end_line: 1 });
          assert.equal(result.stdout, fixture.content);
          assert.equal(result.review_evidence.commit_sha, fixture.artifact.commit_sha);
          assert.equal(result.review_evidence.sha256, fixture.checksum);
          await assert.rejects(options.forgeTools.registry.read_lines.execute({ path: fixture.path, start_line: 1, end_line: 100 }), { code: "READ_LINES_INPUT_INVALID" });
          return { text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [] }) };
        } } } });
      assert.equal((await (await resolver(fixture.job)).review()).verdict, "approved");
      assert.equal(sdkCalls, 1);
      assert.equal(fixture.context.state, "terminal");
    } finally { await rm(fixture.root, { recursive: true, force: true }); }
  });
}

// Supplies governed source-window tools for pre-integration review and preserves verified context identity.
test("hard review resolver provides usable read-only SDK tools", async () => {
  const fixture = await sourceFixture();
  try {
    fixture.job.review_policy.gate = "on";
    const resolver = createAutomaticReviewWorkerResolver({ resolveTicketWorkspace: async () => fixture.workspace, agentResolver: fixture.agentResolver,
      gateways: { openaiSdkGateway: { execute: async ({ options }) => {
        const result = await options.forgeTools.registry.read_lines.execute({ path: fixture.path, start_line: 1, end_line: 1 });
        assert.equal(result.stdout, fixture.content);
        return { text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [] }) };
      } } } });
    const result = await (await resolver(fixture.job)).review();
    assert.equal(result.verdict, "approved");
    assert.equal(result.source_revision, 1);
    assert.equal(fixture.context.state, "reviewing");
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

/** Reproduces a valid ticket whose combined committed source exceeds 200 KB.
 * Review must start with a bounded prompt and expose exact source through Forge
 * windows without losing commit, checksum, or verification identity checks. */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createCommittedReviewSource } from "../../src/modules/supervisor/reviewer-committed-source.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { assertTicketReviewEvidence } from "../../src/modules/supervisor/ticket-review-evidence.js";

const run = promisify(execFile);

// Creates and reviews actual Git objects while the offline SDK double reads a Forge source window.
test("a verified ticket over 200 KB reaches Reviewer with bounded prompt and exact source windows", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-large-review-"));
  try {
    const git = async (...args) => (await run("git", ["-C", root, ...args])).stdout.trim();
    await git("init", "--quiet");
    await git("config", "user.name", "NodeForge Test");
    await git("config", "user.email", "test@example.invalid");
    await writeFile(join(root, "README.md"), "Baseline\n");
    await git("add", "README.md");
    await git("commit", "--quiet", "-m", "Baseline");
    const base = await git("rev-parse", "HEAD");
    await mkdir(join(root, "backend/src"), { recursive: true });
    const paths = Array.from({ length: 5 }, (_, index) => `backend/src/feature-${index}.js`);
    const contents = paths.map((_, index) => Array.from({ length: 240 }, (_, line) => `// source-${index}-${line} ${"x".repeat(200)}`).join("\n") + "\n");
    assert.ok(contents.reduce((sum, content) => sum + Buffer.byteLength(content), 0) > 200_000);
    for (const [index, path] of paths.entries()) await writeFile(join(root, path), contents[index]);
    await git("add", "backend/src");
    await git("commit", "--quiet", "-m", "Ticket source");
    const commit = await git("rev-parse", "HEAD");
    const context = { task_id: "TASK-LARGE", state: "verified", version: 1, review_commit_sha: commit,
      base_sha: base, source_revision: "source-1", manifest_sha: "manifest-1", verification_artifact_id: "ARTIFACT-1", manifest_paths: paths };
    const checksums = Object.fromEntries(paths.map((path, index) => [path, `sha256:${createHash("sha256").update(contents[index]).digest("hex")}`]));
    const artifact = { artifact_id: "ARTIFACT-1", status: "passed", commit_sha: commit, base_sha: base,
      source_revision: "source-1", manifest_sha: "manifest-1", changed_paths: paths, file_checksums: checksums };
    const job = { task_id: context.task_id, agent_id: "CODER", payload: { changed_paths: paths, base_commit: base,
      commit, ticket: { id: context.task_id, execution_policy: { legacy_review_report: true } } } };
    const source = createCommittedReviewSource({ projectRoot: root, commit, baseCommit: base });
    const inputs = { executionContexts: { load: async () => context, update: async (_id, _version, patch) => Object.assign(context, patch) },
      verificationService: { assertPassedArtifact: async () => artifact },
      gitService: { getHead: async () => commit, status: async () => "" }, fileService: source, projectRoot: root };
    let calls = 0;
    const worker = createReviewWorker({ ...inputs,
      agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER", provider: "openai" }) },
      rulesFileService: { readForIndex: async () => ({ content: "Review the verified source through Forge windows." }) },
      openaiSdkGateway: { execute: async ({ prompt, options }) => {
        calls++;
        assert.ok(Buffer.byteLength(prompt) < 64_000);
        assert.match(prompt, /Patches omitted from initial prompt/);
        for (const path of paths) assert.ok(prompt.includes(path));
        assert.ok(!prompt.includes(contents[0].slice(0, 200)));
        const result = await options.forgeTools.registry.read_lines.execute({ path: paths[4], start_line: 2, end_line: 3 });
        assert.equal(result.stdout, contents[4].split("\n").slice(1, 3).join("\n") + "\n");
        assert.equal(result.review_evidence.sha256, checksums[paths[4]]);
        assert.equal(result.review_evidence.commit_sha, commit);
        return { text: '{"verdict":"approved","findings":[]}' };
      } }
    });
    assert.equal((await worker.review(job)).verdict, "approved");
    assert.equal(calls, 1);
    checksums[paths[4]] = "sha256:changed";
    await assert.rejects(assertTicketReviewEvidence({ ...inputs, job }), { code: "REVIEW_SOURCE_MISMATCH" });
    checksums[paths[4]] = `sha256:${createHash("sha256").update(contents[4]).digest("hex")}`;
    context.manifest_paths = Array.from({ length: 25 }, (_, index) => `backend/src/extra-${index}.js`);
    await assert.rejects(assertTicketReviewEvidence({ ...inputs, job }), { code: "REVIEW_EVIDENCE_INVALID" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Checks that independent review receives committed patches and full new-file source.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

const runFile = promisify(execFile);

test("Reviewer sees a committed patch and an untracked new file in one ticket", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-evidence-"));
  try {
    const git = (...args) => runFile("git", args, { cwd: root });
    await git("init", "--quiet");
    await git("config", "user.name", "NodeForge Test");
    await git("config", "user.email", "nodeforge-test@example.invalid");
    await mkdir(join(root, "src"));
    await mkdir(join(root, "workflows/agents"), { recursive: true });
    await writeFile(join(root, "workflows/agents/reviewer.md"), "Review the supplied source and verification evidence.\n");
    await writeFile(join(root, "src/existing.js"), "export const value = 1;\n");
    await git("add", "--", "src/existing.js");
    await git("commit", "--quiet", "-m", "baseline");
    const gitService = createGitService({ projectRoot: root });
    const baseCommit = await gitService.getHead();
    await writeFile(join(root, "src/existing.js"), "export const value = 2;\n");
    await git("add", "--", "src/existing.js");
    await git("commit", "--quiet", "-m", "ticket change");
    await writeFile(join(root, "src/new.js"), "export const added = true;\n");
    let prompt;
    const worker = createReviewWorker({
      agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", provider: "openai", role: "reviewer" }) },
      openaiSdkGateway: { execute: async (input) => { prompt = input.prompt; return { text: '{"verdict":"approved","findings":[]}' }; } },
      fileService: createFileService({ projectRoot: root }), gitService, projectRoot: root
    });
    const result = await worker.review({ task_id: "TASK-1", correlation_id: "CORR-1", request_id: "REVIEW-1", agent_id: "coder-1", payload: { ticket: { id: "TASK-1" }, base_commit: baseCommit, changed_paths: ["src/existing.js", "src/new.js"] } });
    assert.equal(result.verdict, "approved");
    assert.match(prompt, /diff --git a\/src\/existing.js b\/src\/existing.js/);
    assert.match(prompt, /export const added = true/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

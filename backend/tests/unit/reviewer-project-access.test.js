// Verifies independent reviewers can inspect complete project context despite a narrower verification delta.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

const testPath = "backend/tests/integration/routing.test.js";
const routerPath = "backend/src/transport/http/router.js";
const sources = { [testPath]: "test('routing');\n", [routerPath]: "export const router = true;\n",
  "AGENTS.md": "Follow the project review instructions.\n", "docs/contract.md": "Preserve the approved request contract.\n" };
const sha = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;

// Models a two-file manifest whose latest verification delta contains only its test file.
async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), "reviewer-project-access-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries(sources)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await symlink(join(root, "AGENTS.md"), join(root, "linked.md"));
  const fileService = createFileService({ projectRoot: root });
  const files = [testPath, routerPath].map((path) => ({ path, content: sources[path], sha256: sha(sources[path]) }));
  const options = { fileService, projectRoot: root,
    job: { task_id: "REVIEW", request_id: "REVIEW-1", payload: { changed_paths: [testPath] } },
    ticketEvidence: { files, paths: files.map(({ path }) => path),
      artifact: { artifact_id: "ARTIFACT-1", file_checksums: Object.fromEntries(files.map(({ path, sha256 }) => [path, sha256])) },
      context: { review_commit_sha: "COMMIT-1", manifest_sha: "MANIFEST-1" } },
    codeCache: { read: (input) => fileService.readForIndex(input) } };
  return { root, options };
}

test("every provider can read manifest source outside the delta and project instructions/contracts", async (context) => {
  const { options } = await fixture(context);
  for (const provider of ["codex", "openai", "claude", "anthropic"]) {
    const tools = createReviewerForgeTools({ ...options, reviewer: { agent_id: "reviewer", provider } });
    const router = await tools.registry.read_file.execute({ path: routerPath });
    assert.equal(router.sha256, sha(sources[routerPath]));
    assert.equal(router.review_evidence.artifact_id, "ARTIFACT-1");
    assert.equal(router.review_evidence.commit_sha, "COMMIT-1");
    const window = await tools.registry.read_lines.execute({ path: routerPath, start_line: 1, end_line: 1 });
    assert.equal(window.stdout, sources[routerPath]);
    assert.equal(window.review_evidence.sha256, router.sha256);
    for (const path of ["AGENTS.md", "docs/contract.md"]) {
      const file = await tools.registry.read_file.execute({ path });
      assert.equal(file.sha256, sha(sources[path]));
      assert.equal(file.review_evidence, undefined);
      assert.equal((await tools.registry.read_lines.execute({ path, start_line: 1, end_line: 1 })).stdout, sources[path]);
    }
    for (const name of ["write_diff", "edit_diff", "commit_changes", "push_commit", "run_check"]) assert.equal(tools.registry[name], undefined);
  }
});

test("project-wide review rejects protected paths and symlinks before consulting an otherwise permissive cache", async (context) => {
  const { options } = await fixture(context);
  let reads = 0;
  const tools = createReviewerForgeTools({ ...options, reviewer: { agent_id: "reviewer", provider: "codex" },
    codeCache: { read: async () => { reads += 1; return { content: "Cache must not bypass read policy" }; } } });
  for (const path of ["../outside", "/etc/passwd", ".forge/runtime/state.json", ".env", "node_modules/pkg/.env", "secrets/key.js", "linked.md"]) {
    for (const name of ["read_file", "read_lines"]) {
      await assert.rejects(() => tools.registry[name].execute({ path, ...(name === "read_lines" ? { start_line: 1, end_line: 1 } : {}) }),
        { code: "FILE_ROLE_FORBIDDEN" });
    }
  }
  assert.equal(reads, 0);
});

test("broader review access continues rejecting drift in artifact-bound manifest files", async (context) => {
  const { root, options } = await fixture(context);
  const tools = createReviewerForgeTools({ ...options, reviewer: { agent_id: "reviewer", provider: "codex" } });
  await writeFile(join(root, routerPath), "unverified source\n");
  for (const name of ["read_file", "read_lines"]) {
    await assert.rejects(() => tools.registry[name].execute({ path: routerPath,
      ...(name === "read_lines" ? { start_line: 1, end_line: 1 } : {}) }), { code: "REVIEW_SOURCE_MISMATCH" });
  }
});

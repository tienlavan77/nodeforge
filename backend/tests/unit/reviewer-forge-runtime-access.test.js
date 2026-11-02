// Verifies reviewers can inspect live Forge runtime evidence while mutations and symlink escapes remain forbidden.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService, assertRoleFileAccess } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

test("reviewer reads live Forge evidence with a fixed source snapshot and cannot mutate or escape", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "forge-review-runtime-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".forge/runtime"), { recursive: true });
  await writeFile(join(root, ".forge/runtime/evidence.md"), "Runtime evidence\n");
  await symlink("/etc/passwd", join(root, ".forge/runtime/escape.md"));
  const files = createRoleFileService({ fileService: createFileService({ projectRoot: root }), role: "reviewer", projectRoot: root });
  assert.equal(await files.readFile({ path: ".forge/runtime/evidence.md" }), "Runtime evidence\n");
  for (const operation of ["write", "delete", "move"]) {
    assert.throws(() => assertRoleFileAccess("reviewer", operation, ".forge/runtime/evidence.md"), { code: "FILE_ROLE_FORBIDDEN" });
  }
  await assert.rejects(() => files.readFile({ path: ".forge/runtime/escape.md" }), { code: "FILE_ROLE_FORBIDDEN" });
  const source = { committedReview: true, reviewCommit: "a".repeat(40),
    readForIndex: async () => { throw new Error("Runtime must not be read from Git snapshot"); },
    listFiles: async () => [], listDirectories: async () => [] };
  const tools = createReviewerForgeTools({ fileService: source, projectRoot: root,
    job: { task_id: "TASK-RUNTIME", correlation_id: "CORR-RUNTIME", payload: {} },
    reviewer: { agent_id: "rv", provider: "codex" } });
  const metadata = await tools.registry.read_file.execute({ path: ".forge/runtime/evidence.md" });
  assert.ok(JSON.stringify(metadata).includes("Runtime evidence"));
  const read = await tools.registry.Read.execute({ file_path: ".forge/runtime/evidence.md", start_line: 1, end_line: 1 });
  assert.ok(JSON.stringify(read).includes("Runtime evidence"));
  assert.equal(read.review_source, undefined);
  const search = await tools.registry.search_text.execute({ paths: [".forge/runtime"], pattern: "Runtime evidence" });
  assert.ok(search.stdout.includes("Runtime evidence"));
  const tree = await tools.registry.search_tree.execute({ path: ".forge/runtime", max_depth: 1 });
  assert.ok(JSON.stringify(tree).includes("evidence.md"));
  await assert.rejects(() => tools.registry.read_file.execute({ path: ".forge/runtime/escape.md" }), { code: "FILE_ROLE_FORBIDDEN" });
});

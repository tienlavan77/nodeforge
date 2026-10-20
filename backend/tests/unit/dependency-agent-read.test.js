// Verifies agents can read installed backend/UI guidance through Forge without crossing project or write boundaries.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool, createWriteDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createOwnerSearchTreeTool } from "../../src/tools/owner-search-tree.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/reviewer-forge-tools.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker-recovery-tools.js";

// Models pnpm links to a shared in-project package store and one forbidden external package.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-dependency-read-"));
  const outside = await mkdtemp(join(tmpdir(), "nf-external-dependency-"));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]));
  const store = "node_modules/.pnpm/package/node_modules/next";
  const docs = "dist/docs/01-app/03-api-reference/01-directives/use-client.md";
  await mkdir(join(root, store, dirname(docs)), { recursive: true });
  await writeFile(join(root, store, docs), "# use client\nRead installed package guidance.\n");
  await writeFile(join(root, store, ".env"), "PRIVATE=1\n");
  await writeFile(join(outside, "guide.md"), "external\n");
  for (const base of ["backend", "ui/nextjs"]) {
    await mkdir(join(root, base, "node_modules"), { recursive: true });
    await symlink(join(root, store), join(root, base, "node_modules/next"));
    await symlink(outside, join(root, base, "node_modules/external"));
  }
  const files = createFileService({ projectRoot: root });
  const context = { task_id: "DEPENDENCY-READ", project_root: root, capabilities: ["search_tree", "read_file", "read_lines", "write_diff"], allowed_prefixes: ["backend", "ui"] };
  return { root, files, context, docs, store };
}

test("all coding roles discover and read backend/UI package links while bypassing the source cache", async (t) => {
  const f = await fixture(t);
  const cache = { read: async () => { throw new Error("Dependencies must not enter Code Cache"); } };
  for (const role of ["coder", "sprint_leader", "architecture_manager", "reviewer", "system_engineer"]) {
    const scoped = createRoleFileService({ fileService: f.files, projectRoot: f.root, role });
    const context = { ...f.context, agent_identity: { role } };
    for (const base of ["backend", "ui/nextjs"]) {
      const path = `${base}/node_modules/next/${f.docs}`;
      const directory = `${base}/node_modules/next/dist/docs`;
      const tree = await createOwnerSearchTreeTool({ fileService: scoped, role }).execute({ path: directory, max_depth: 8 }, context);
      assert(tree.entries.some((entry) => entry.path === path));
      const file = await createReadFileTool({ fileService: scoped, codeCache: cache, projectRoot: f.root }).execute({ path }, context);
      assert.match(file.content, /Read installed package guidance/);
      assert.equal(file.cache.status, "bypass");
      assert.equal((await scoped.readForIndex({ path })).sha256, file.sha256);
      const lines = await createSedLinesTool({ projectRoot: f.root, fileService: scoped, codeCache: cache, toolName: "read_lines", logger: { emit() {} } }).execute({ path, start_line: 1, end_line: 2 }, context);
      assert.match(lines.stdout, /Read installed package guidance/);
      assert.equal(lines.sha256, file.sha256);
      await assert.rejects(scoped.atomicWrite({ path, content: "changed", replace: true }), { code: "FILE_ROLE_FORBIDDEN" });
    }
  }
});

test("external links, package secrets, traversal and dependency writes stay forbidden", async (t) => {
  const f = await fixture(t);
  const scoped = createRoleFileService({ fileService: f.files, projectRoot: f.root, role: "system_engineer" });
  for (const path of ["backend/node_modules/external/guide.md", "ui/nextjs/node_modules/next/.env", "backend/node_modules/next/../next/.env", "/etc/passwd"]) {
    await assert.rejects(scoped.readForIndex({ path }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  const write = createWriteDiffTool({ fileService: f.files });
  await assert.rejects(write.execute({ path: `backend/node_modules/next/${f.docs}`, before_checksum: null, content: "no" }, f.context), { code: "PATH_FORBIDDEN" });
  await assert.rejects(scoped.readForIndex({ path: `backend/node_modules/next/${f.docs}x` }), { code: "ENOENT" });
});

test("production Coder and Reviewer registries expose the same dependency reads and bounded discovery", async (t) => {
  const f = await fixture(t);
  const path = `ui/nextjs/node_modules/next/${f.docs}`;
  const directory = "ui/nextjs/node_modules/next/dist/docs";
  const coder = createForgeToolRegistry({ fileService: f.files, projectRoot: f.root, protocolStorage: { get: async () => null } });
  const context = { ...f.context, agent_identity: { role: "coder", agent_id: "CODER" } };
  const tree = await coder.search_tree.execute({ path: directory, max_depth: 8 }, context);
  assert(tree.entries.some((entry) => entry.path === path));
  assert.match((await coder.read_file.execute({ path }, context)).content, /use client/);
  assert.match((await coder.read_lines.execute({ path, start_line: 1, end_line: 2 }, context)).stdout, /use client/);
  const reviewer = createReviewerForgeTools({ fileService: f.files, projectRoot: f.root, job: { task_id: "REVIEW" }, reviewer: { agent_id: "R", provider: "claude" } });
  assert.match((await reviewer.registry.read_file.execute({ path })).content, /use client/);
  assert.match((await reviewer.registry.read_lines.execute({ path, start_line: 1, end_line: 2 })).stdout, /use client/);
  assert((await reviewer.registry.search_tree.execute({ path: directory, max_depth: 8 })).entries.some((entry) => entry.path === path));
});

test("SL and AM recovery read real package filenames without access escalation", async (t) => {
  const f = await fixture(t);
  const path = `ui/nextjs/node_modules/next/${f.docs}`;
  for (const role of ["sprint_leader", "architecture_manager"]) {
    const tools = blockerRecoveryTools({ fileService: f.files, projectRoot: f.root, profile: { role, agent_id: role }, task_id: "T", job: { stage: role } });
    assert.match((await tools.registry.read_file.execute({ path })).content, /use client/);
    assert.match((await tools.registry.read_lines.execute({ path, start_line: 1, end_line: 2 })).stdout, /use client/);
  }
});

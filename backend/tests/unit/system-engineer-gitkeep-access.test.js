// Verifies generic System Engineer placeholder cleanup through owner authorization,
// scoped File Service and checksum-guarded deletion without depending on unrelated tools.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService, assertRoleFileAccess } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { authorizeOwnerTool, ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";
import { createOwnerDeleteFileTool } from "../../src/tools/roles/owner-delete-file.js";

// Exercises the generic SE exception at root and nested paths through every authorization layer.
// Checksums and role boundaries must still hold when a new source directory needs cleanup.
test("SE deletes exact gitkeep files throughout the project with checksum protection", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-project-gitkeep-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const context = { task_id: "SE-GITKEEP", project_root: projectRoot, project_wide_access: true,
    capabilities: [...ownerRoleTools("system_engineer")], agent_identity: { role: "system_engineer" } };
  const files = createRoleFileService({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }) });
  const tool = createOwnerDeleteFileTool({ fileService: files });
  for (const path of [".gitkeep", "backend/src/modules/agents/.gitkeep", "docs/other/.gitkeep", "docs/archive/sprints/.gitkeep"]) {
    await mkdir(join(projectRoot, path, ".."), { recursive: true });
    await writeFile(join(projectRoot, path), "keep\n");
    await authorizeOwnerTool("delete_file", { path }, context, projectRoot);
    const before_checksum = "sha256:" + createHash("sha256").update("keep\n").digest("hex");
    await assert.rejects(tool.execute({ path, before_checksum: "sha256:" + "0".repeat(64) }, context), { code: "CHECKSUM_MISMATCH" });
    assert.equal(await readFile(join(projectRoot, path), "utf8"), "keep\n");
    assert.throws(() => assertRoleFileAccess("system_engineer", "write", path), { code: "FILE_ROLE_FORBIDDEN" });
    assert.throws(() => assertRoleFileAccess("architecture_manager", "delete", path), { code: "FILE_ROLE_FORBIDDEN" });
    await tool.execute({ path, before_checksum }, context);
    await assert.rejects(readFile(join(projectRoot, path)), { code: "ENOENT" });
    assert.ok(context.changed_paths.includes(path));
  }
  for (const path of ["/.gitkeep", "../.gitkeep", "docs//.gitkeep", ".git/.gitkeep", "docs/.private/.gitkeep", "docs/private/.gitkeep", "dist/.gitkeep", "backend/node_modules/pkg/.gitkeep"]) {
    await assert.rejects(authorizeOwnerTool("delete_file", { path }, context, projectRoot), { code: "TOOL_FORBIDDEN" });
  }
});

// Keeps placeholder cleanup inside real project directories even when an otherwise valid path
// names a symlinked file or parent, preserving the original target and its contents.
test("SE gitkeep deletion rejects symlinked files and parents", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-gitkeep-symlink-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "retained"));
  await mkdir(join(projectRoot, "src"));
  await writeFile(join(projectRoot, "retained/.gitkeep"), "keep");
  await symlink(join(projectRoot, "retained"), join(projectRoot, "src/linked"));
  await symlink(join(projectRoot, "retained/.gitkeep"), join(projectRoot, "src/.gitkeep"));
  const fileService = createRoleFileService({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }) });
  const tool = createOwnerDeleteFileTool({ fileService });
  for (const path of ["src/linked/.gitkeep", "src/.gitkeep"]) {
    await assert.rejects(tool.execute({ path, before_checksum: "sha256:" + createHash("sha256").update("keep").digest("hex") }), { code: "FILE_ROLE_FORBIDDEN" });
  }
  assert.equal(await readFile(join(projectRoot, "retained/.gitkeep"), "utf8"), "keep");
});

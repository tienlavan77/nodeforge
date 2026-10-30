// Verifies the owner's narrowly authorized restructuring permissions through Forge owner tools and the real scoped filesystem service, so System Engineer can update the root architecture overview and remove its obsolete domain placeholder while other protected paths and symlink boundaries remain enforced.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService, assertRoleFileAccess } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { authorizeOwnerTool, ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";

test("owner Forge tools edit root architecture and remove project placeholders", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-restructure-access-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "backend/src/domain"), { recursive: true });
  const before = "# Before\n";
  await writeFile(join(projectRoot, "ARCHITECTURE.md"), before);
  await writeFile(join(projectRoot, "backend/src/domain/.gitkeep"), "\n");
  const context = { task_id: "SE-RESTRUCTURE-ACCESS", project_root: projectRoot, project_wide_access: true,
    capabilities: [...ownerRoleTools("system_engineer")], agent_identity: { role: "system_engineer" } };
  const tools = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }), context });
  await tools.registry.edit_diff.execute({ path: "ARCHITECTURE.md", anchor: "# Before", replacement: "# After",
    before_checksum: "sha256:" + createHash("sha256").update(before).digest("hex") }, context);
  assert.equal(await readFile(join(projectRoot, "ARCHITECTURE.md"), "utf8"), "# After\n");
  await tools.registry.delete_file.execute({ path: "backend/src/domain/.gitkeep",
    before_checksum: "sha256:" + createHash("sha256").update("\n").digest("hex") }, context);
  await assert.rejects(readFile(join(projectRoot, "backend/src/domain/.gitkeep")), { code: "ENOENT" });
  await mkdir(join(projectRoot, "docs/sprints"), { recursive: true });
  await writeFile(join(projectRoot, "docs/sprints/.gitkeep"), "\n");
  const placeholder = { path: "docs/sprints/.gitkeep", before_checksum: "sha256:" + createHash("sha256").update("\n").digest("hex") };
  await assert.rejects(tools.registry.delete_file.execute({ ...placeholder, before_checksum: "sha256:" + "0".repeat(64) }, context), { code: "CHECKSUM_MISMATCH" });
  await tools.registry.delete_file.execute(placeholder, context);
  await assert.rejects(readFile(join(projectRoot, placeholder.path)), { code: "ENOENT" });
  for (const path of ["docs/sprints/../sprints/.gitkeep", "docs/sprints/.gitkeep/child", "docs/.private/.gitkeep", "node_modules/pkg/.gitkeep"]) {
    await assert.rejects(authorizeOwnerTool("delete_file", { path }, context, projectRoot), { code: "TOOL_FORBIDDEN" });
  }
  await assert.rejects(authorizeOwnerTool("write_diff", { path: placeholder.path }, context, projectRoot), { code: "TOOL_FORBIDDEN" });
  assert.throws(() => assertRoleFileAccess("architecture_manager", "delete", placeholder.path), { code: "FILE_ROLE_FORBIDDEN" });
});

test("PNG metadata and archival use original binary bytes through owner Forge tools", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-restructure-png-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "docs"), { recursive: true });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255, 128]);
  await writeFile(join(projectRoot, "docs/diagram.png"), bytes);
  const context = { task_id: "SE-RESTRUCTURE-PNG", project_root: projectRoot, project_wide_access: true,
    capabilities: [...ownerRoleTools("system_engineer")], agent_identity: { role: "system_engineer" } };
  const codeCache = { read: async () => { throw new Error("Binary metadata must bypass the source index."); }, invalidate: () => {} };
  const tools = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }), codeCache, context });
  const metadata = await tools.registry.read_file.execute({ path: "docs/diagram.png" }, context);
  const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  assert.deepEqual(metadata, { path: "docs/diagram.png", sha256, size_bytes: bytes.length, binary: true, content_omitted: true });
  await assert.rejects(tools.registry.move_file.execute({ from_path: "docs/diagram.png", to_path: "docs/assets/diagram.png", before_checksum: "sha256:" + "0".repeat(64) }, context), { code: "CHECKSUM_MISMATCH" });
  await tools.registry.move_file.execute({ from_path: "docs/diagram.png", to_path: "docs/assets/diagram.png", before_checksum: sha256 }, context);
  assert.deepEqual(await readFile(join(projectRoot, "docs/assets/diagram.png")), bytes);
  await assert.rejects(readFile(join(projectRoot, "docs/diagram.png")), { code: "ENOENT" });
  await symlink(join(projectRoot, "docs/assets/diagram.png"), join(projectRoot, "docs/link.png"));
  await assert.rejects(tools.registry.read_file.execute({ path: "docs/link.png" }, context), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(tools.registry.read_file.execute({ path: ".git/diagram.png" }, context));
});

// Exercises owner-authorized backup cleanup through real Forge tools so text and
// binary backups can be deleted only with their original byte checksum. Protected
// paths, symlink boundaries and other owner roles must retain their restrictions.
test("backup deletion uses raw checksums and retains role and path boundaries", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-restructure-backup-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "docs/archive"), { recursive: true });
  const context = { task_id: "SE-RESTRUCTURE-BACKUP", project_root: projectRoot, project_wide_access: true,
    capabilities: [...ownerRoleTools("system_engineer")], agent_identity: { role: "system_engineer" } };
  const tools = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }), context });
  for (const [path, bytes] of [
    ["docs/archive/sprint.md.bak", Buffer.from("# Historical backup\n")],
    ["docs/archive/snapshot.BAK", Buffer.from([0, 255, 128, 13, 10])]
  ]) {
    await mkdir(join(projectRoot, "docs/archive"), { recursive: true });
    await writeFile(join(projectRoot, path), bytes);
    const sha256 = "sha256:" + createHash("sha256").update(bytes).digest("hex");
    const metadata = await tools.registry.read_file.execute({ path }, context);
    assert.deepEqual(metadata, { path, sha256, size_bytes: bytes.length, backup: true, content_omitted: true });
    await assert.rejects(tools.registry.delete_file.execute({ path, before_checksum: "sha256:" + "0".repeat(64) }, context), { code: "CHECKSUM_MISMATCH" });
    assert.deepEqual(await readFile(join(projectRoot, path)), bytes);
    const result = await tools.registry.delete_file.execute({ path, before_checksum: sha256 }, context);
    assert.equal(result.deleted, true);
    assert.equal(result.before_sha256, sha256);
    assert.ok(context.changed_paths.includes(path));
    await assert.rejects(readFile(join(projectRoot, path)), { code: "ENOENT" });
  }
  await mkdir(join(projectRoot, "docs"), { recursive: true });
  await writeFile(join(projectRoot, "docs/retained.bak"), "retained");
  await symlink(join(projectRoot, "docs/retained.bak"), join(projectRoot, "docs/link.bak"));
  await assert.rejects(tools.registry.delete_file.execute({ path: "docs/link.bak", before_checksum: "sha256:" + "0".repeat(64) }, context), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal(await readFile(join(projectRoot, "docs/retained.bak"), "utf8"), "retained");
  for (const path of [".env.bak", ".git/config.bak", "docs/private/state.bak", "../outside.bak"]) {
    await assert.rejects(authorizeOwnerTool("delete_file", { path }, context, projectRoot), { code: "TOOL_FORBIDDEN" });
  }
  await assert.rejects(authorizeOwnerTool("delete_file", { path: "docs/archive/sprint.md.bak" }, {
    ...context, capabilities: [...ownerRoleTools("architecture_manager")], agent_identity: { role: "architecture_manager" }
  }, projectRoot), { code: "TOOL_FORBIDDEN" });
});

test("restructuring exceptions preserve operation, role and private-path boundaries", async () => {
  const context = { task_id: "SE-RESTRUCTURE-BOUNDARY", capabilities: [...ownerRoleTools("system_engineer")], agent_identity: { role: "system_engineer" } };
  for (const path of ["AGENTS.md", "CLAUDE.md", "vocabulary/glossary.md", "nested/ARCHITECTURE.md", "backend/src/domain/.gitkeep"]) {
    assert.throws(() => assertRoleFileAccess("system_engineer", "write", path), { code: "FILE_ROLE_FORBIDDEN" });
  }
  assert.throws(() => assertRoleFileAccess("system_engineer", "delete", "ARCHITECTURE.md"), { code: "FILE_ROLE_FORBIDDEN" });
  for (const path of [".env", ".git/config", "backend/src/other/.gitkeep.bak", "backend/src/domain/../domain/.gitkeep", "backend/src/domain/.gitkeep/child"]) {
    await assert.rejects(authorizeOwnerTool("delete_file", { path }, context, "/project"), { code: "TOOL_FORBIDDEN" });
  }
  await assert.rejects(authorizeOwnerTool("write_diff", { path: "backend/src/domain/.gitkeep" }, context, "/project"), { code: "TOOL_FORBIDDEN" });
  assert.throws(() => assertRoleFileAccess("reviewer", "write", "ARCHITECTURE.md"), { code: "FILE_ROLE_FORBIDDEN" });
  const planning = { ...context, planning_input_only: true };
  await assert.rejects(authorizeOwnerTool("edit_diff", { path: "ARCHITECTURE.md" }, planning, "/project"), { code: "TOOL_FORBIDDEN" });
});

test("domain placeholder deletion still rejects symlinked parents", async (t) => {
  const projectRoot = await mkdtemp(join(tmpdir(), "se-restructure-link-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await mkdir(join(projectRoot, "retained"), { recursive: true });
  await writeFile(join(projectRoot, "retained/.gitkeep"), "keep");
  await mkdir(join(projectRoot, "backend/src"), { recursive: true });
  await symlink(join(projectRoot, "retained"), join(projectRoot, "backend/src/domain"));
  await mkdir(join(projectRoot, "docs"), { recursive: true });
  await symlink(join(projectRoot, "retained"), join(projectRoot, "docs/sprints"));
  const scoped = createRoleFileService({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }) });
  await assert.rejects(scoped.deleteFile({ path: "backend/src/domain/.gitkeep" }), { code: "FILE_ROLE_FORBIDDEN" });
  await assert.rejects(scoped.deleteFile({ path: "docs/sprints/.gitkeep" }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal(await readFile(join(projectRoot, "retained/.gitkeep"), "utf8"), "keep");
});

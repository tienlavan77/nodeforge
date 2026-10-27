// Verifies cascading empty-parent directory cleanup after delete_file and move_file operations while preserving project root, .git, .forge, and non-empty directories.
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";

// Returns true when the given path exists on disk and false when absent.
async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("deleting a deeply nested file prunes empty parent directories up to non-empty ancestors and stops before project root", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-cleanup-delete-"));
  try {
    const events = [];
    const files = createFileService({ projectRoot: root, internalBus: { emit: (type, payload) => events.push({ type, payload }) } });
    await files.atomicWrite({ path: "src/features/keep.js", content: "export const keep = true;\n", replace: true });
    await files.atomicWrite({ path: "src/features/obsolete/nested/deep/leaf.js", content: "export const leaf = 1;\n", replace: true });
    await files.atomicWrite({ path: "isolated/one/two/only.js", content: "export const only = 1;\n", replace: true });

    await files.deleteFile({ path: "src/features/obsolete/nested/deep/leaf.js" });
    assert.equal(await pathExists(join(root, "src/features/obsolete")), false);
    assert.equal(await pathExists(join(root, "src/features")), true);
    assert.equal(await pathExists(join(root, "src/features/keep.js")), true);

    await files.deleteFile({ path: "isolated/one/two/only.js" });
    assert.equal(await pathExists(join(root, "isolated")), false);
    assert.equal(await pathExists(root), true);
    assert.ok(events.some((event) => event.type === "directory.deleted" && event.payload.path === "isolated"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moving a file out of its source directory prunes empty source ancestors without removing destination ancestors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-cleanup-move-"));
  try {
    const files = createFileService({ projectRoot: root });
    await files.atomicWrite({ path: "packages/alpha/legacy/deep/module.js", content: "export const v = 1;\n", replace: true });
    await files.renameFile({ from: "packages/alpha/legacy/deep/module.js", to: "packages/alpha/current/module.js" });

    assert.equal(await pathExists(join(root, "packages/alpha/legacy")), false);
    assert.equal(await pathExists(join(root, "packages/alpha/current/module.js")), true);
    assert.equal(await pathExists(join(root, "packages/alpha")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanup inside .forge prunes empty subdirectories but never deletes .forge root or .git", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-cleanup-forge-"));
  try {
    await mkdir(join(root, ".git/refs/heads"), { recursive: true });
    const seFiles = createFileService({ projectRoot: root, role: "system_engineer" });
    await seFiles.atomicWrite({ path: ".forge/custom/nested/temp.json", content: "{}\n", replace: true });
    await seFiles.deleteFile({ path: ".forge/custom/nested/temp.json" });

    assert.equal(await pathExists(join(root, ".forge/custom")), false);
    assert.equal(await pathExists(join(root, ".forge")), true);
    assert.equal(await pathExists(join(root, ".git")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("negative cleanup cases preserve forbidden boundaries and block direct Coder mutations without ledger", async () => {
  const root = await mkdtemp(join(tmpdir(), "nf-cleanup-negative-"));
  const outside = await mkdtemp(join(tmpdir(), "nf-cleanup-outside-"));
  try {
    await mkdir(join(root, ".git"), { recursive: true });
    await writeFile(join(root, ".git/config"), "[core]\n");
    await writeFile(join(root, ".env"), "SECRET=1\n");
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/index.js"), "module.exports = {};\n");
    await writeFile(join(root, "AGENTS.md"), "# Agents\n");
    await mkdir(join(root, "workflows"), { recursive: true });
    await writeFile(join(root, "workflows/flow.json"), "{}\n");

    const baseFiles = createFileService({ projectRoot: root });
    const seRoleFiles = createRoleFileService({ fileService: baseFiles, role: "system_engineer", projectRoot: root });
    const coderRoleFiles = createRoleFileService({ fileService: baseFiles, role: "coder", projectRoot: root });

    await symlink(outside, join(root, "symlink-dir"));
    await assert.rejects(() => seRoleFiles.deleteFile({ path: "symlink-dir/target.js" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => seRoleFiles.deleteFile({ path: ".env" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => seRoleFiles.deleteFile({ path: ".git/config" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => seRoleFiles.deleteFile({ path: "node_modules/pkg/index.js" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => seRoleFiles.deleteFile({ path: "AGENTS.md" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => coderRoleFiles.deleteFile({ path: "workflows/flow.json" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => coderRoleFiles.moveFile({ from_path: "workflows/flow.json", to_path: "src/flow.json" }), { code: "FILE_ROLE_FORBIDDEN" });

    assert.equal(await pathExists(join(root, ".env")), true);
    assert.equal(await pathExists(join(root, ".git/config")), true);
    assert.equal(await pathExists(join(root, "node_modules/pkg/index.js")), true);
    assert.equal(await pathExists(join(root, "AGENTS.md")), true);
    assert.equal(await pathExists(join(root, "workflows/flow.json")), true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

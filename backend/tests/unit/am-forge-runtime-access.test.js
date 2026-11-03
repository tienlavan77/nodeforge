// Verifies Architecture Manager runtime inspection through its role-bound File Service.
// Plan and runtime text may be inspected without granting runtime mutations or symlink escapes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService, assertRoleFileAccess } from "../../src/infrastructure/filesystem/file-service-role-policy.js";

test("AM reads and discovers Forge files while runtime mutations and symlinks remain forbidden", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "am-forge-access-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".forge/runtime"), { recursive: true });
  await writeFile(join(root, ".forge/runtime/plan.md"), "Approved plan\n");
  await symlink("/etc/passwd", join(root, ".forge/runtime/escape.md"));
  const files = createRoleFileService({ fileService: createFileService({ projectRoot: root }), role: "architecture_manager", projectRoot: root });
  assert.equal(await files.readFile({ path: ".forge/runtime/plan.md" }), "Approved plan\n");
  assert.equal((await files.readForIndex({ path: ".forge/runtime/plan.md" })).content, "Approved plan\n");
  assert.ok((await files.listFiles({ glob: ".forge/**" })).includes(".forge/runtime/plan.md"));
  for (const operation of ["write", "delete", "move"]) {
    assert.throws(() => assertRoleFileAccess("architecture_manager", operation, ".forge/runtime/plan.md"), { code: "FILE_ROLE_FORBIDDEN" });
  }
  await assert.rejects(() => files.readFile({ path: ".forge/runtime/escape.md" }), { code: "FILE_ROLE_FORBIDDEN" });
});

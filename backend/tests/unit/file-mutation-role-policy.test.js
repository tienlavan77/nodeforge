// Verifies role-based file mutation permissions, protected path guardrails, and fail-closed Coder ledger boundaries for delete_file and move_file.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { assertRoleFileAccess, createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { authorizeOwnerTool, ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { bindEngineeringTools } from "../../src/tools/engineering-tool-binding.js";
import { ENGINEERING_TOOL_NAMES, CODER_TOOL_NAMES } from "../../src/tools/engineering-tool-catalog.js";
import { issueExecutionFileAccess } from "../../src/tools/execution-file-access.js";

// Computes the canonical sha256 checksum string used by Forge mutation tools.
function sha256(content) {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

test("system_engineer can delete_file and move_file across permitted project and .forge paths while architecture_manager stays restricted", async () => {
  assert.ok(ownerRoleTools("system_engineer").includes("delete_file"));
  assert.ok(ownerRoleTools("system_engineer").includes("move_file"));
  assert.ok(ownerRoleTools("architecture_manager").includes("delete_file"));
  assert.equal(ownerRoleTools("architecture_manager").includes("move_file"), false);

  for (const path of ["src/module.js", "backend/tools/helper.js", ".forge/runtime/state.json", ".forge/config/settings.json"]) {
    assert.doesNotThrow(() => assertRoleFileAccess("system_engineer", "delete", path));
    assert.doesNotThrow(() => assertRoleFileAccess("system_engineer", "move", path));
  }

  assert.doesNotThrow(() => assertRoleFileAccess("architecture_manager", "delete", "workflows/obsolete.md"));
  for (const forbiddenDelete of ["docs/architecture.md", "ARCHITECTURE.md", "Skills/guide.md", "src/module.js", ".forge/state.json"]) {
    assert.throws(() => assertRoleFileAccess("architecture_manager", "delete", forbiddenDelete), { code: "FILE_ROLE_FORBIDDEN" });
  }
  for (const forbiddenMove of ["workflows/obsolete.md", "docs/architecture.md", "ARCHITECTURE.md", "src/module.js"]) {
    assert.throws(() => assertRoleFileAccess("architecture_manager", "move", forbiddenMove), { code: "FILE_ROLE_FORBIDDEN" });
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "nf-role-mutation-"));
  try {
    const fileService = createFileService({ projectRoot });
    await fileService.atomicWrite({ path: "src/old.js", content: "// module\nexport const x = 1;\n", replace: true });
    await mkdir(join(projectRoot, ".forge/custom"), { recursive: true });
    await writeFile(join(projectRoot, ".forge/custom/data.json"), "{\"ok\":true}\n");

    const seContext = {
      task_id: "SE-MUTATION",
      conversation_id: "CONV-SE",
      project_wide_access: true,
      project_root: projectRoot,
      capabilities: [...ownerRoleTools("system_engineer")],
      agent_identity: { agent_id: "se", role: "system_engineer", provider: "claude" }
    };
    const seTools = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService, context: seContext });
    await seTools.registry.move_file.execute({
      from_path: "src/old.js",
      to_path: "src/relocated/new.js",
      before_checksum: sha256("// module\nexport const x = 1;\n")
    }, seContext);
    assert.equal(await readFile(join(projectRoot, "src/relocated/new.js"), "utf8"), "// module\nexport const x = 1;\n");
    await assert.rejects(() => readFile(join(projectRoot, "src/old.js"), "utf8"), { code: "ENOENT" });

    await seTools.registry.move_file.execute({
      from_path: ".forge/custom/data.json",
      to_path: ".forge/custom/moved.json",
      before_checksum: sha256("{\"ok\":true}\n")
    }, seContext);
    await seTools.registry.delete_file.execute({
      path: ".forge/custom/moved.json",
      before_checksum: sha256("{\"ok\":true}\n")
    }, seContext);
    await assert.rejects(() => readFile(join(projectRoot, ".forge/custom/moved.json"), "utf8"), { code: "ENOENT" });

    const amContext = {
      task_id: "AM-MUTATION",
      conversation_id: "CONV-AM",
      project_root: projectRoot,
      capabilities: [...ownerRoleTools("architecture_manager"), "move_file"],
      agent_identity: { agent_id: "am", role: "architecture_manager", provider: "claude" }
    };
    await assert.rejects(
      () => authorizeOwnerTool("move_file", { from_path: "workflows/a.md", to_path: "workflows/b.md", before_checksum: sha256("x") }, amContext, projectRoot),
      { code: "TOOL_FORBIDDEN" }
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("other roles retain protected paths while Coder mutations require a ledger and reject escapes", async () => {
  for (const name of [...ENGINEERING_TOOL_NAMES, ...CODER_TOOL_NAMES]) {
    assert.doesNotMatch(name, /directory|mkdir|rmdir/i);
  }

  const projectRoot = await mkdtemp(join(tmpdir(), "nf-negative-guardrails-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "nf-outside-"));
  try {
    const fileService = createFileService({ projectRoot });
    const seScoped = createRoleFileService({ fileService, role: "system_engineer", projectRoot });
    const coderScoped = createRoleFileService({ fileService, role: "coder", projectRoot });

    for (const forbidden of [".env", "config/.env.local", "certs/private.key", ".hidden/file.js", "src/.hidden.js", "node_modules/pkg/index.js", "AGENTS.md", "CLAUDE.md", "ARCHITECTURE.md", "vocabulary/glossary.md"]) {
      await assert.rejects(() => seScoped.deleteFile({ path: forbidden }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(() => seScoped.moveFile({ from_path: forbidden, to_path: "src/allowed.js" }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(() => seScoped.moveFile({ from_path: "src/allowed.js", to_path: forbidden }), { code: "FILE_ROLE_FORBIDDEN" });
    }

    await mkdir(join(projectRoot, "src"), { recursive: true });
    await symlink(outsideRoot, join(projectRoot, "src/linked"));
    await assert.rejects(() => seScoped.deleteFile({ path: "src/linked/file.js" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => seScoped.moveFile({ from_path: "src/linked/file.js", to_path: "src/safe.js" }), { code: "FILE_ROLE_FORBIDDEN" });

    await writeFile(join(projectRoot, "src/allowed.js"), "allowed");
    await coderScoped.deleteFile({ path: "src/allowed.js" });
    await writeFile(join(projectRoot, "src/allowed.js"), "allowed");
    await coderScoped.moveFile({ from_path: "src/allowed.js", to_path: "src/other.js" });
    assert.equal(await readFile(join(projectRoot, "src/other.js"), "utf8"), "allowed");

    const policyIdentity = { id: "policy-1", revision: "1", sha256: `sha256:${"b".repeat(64)}` };
    const baseContext = {
      task_id: "TICKET-1",
      execution_id: "EXEC-1",
      project_root: projectRoot,
      agent_identity: { agent_id: "CODER-1", role: "coder", provider: "claude" },
      capabilities: [...CODER_TOOL_NAMES],
      allowed_file_paths: ["src/a.js", "src/b.js", "workflows/agents/coder/README.md", "AGENTS.md"],
      allowed_prefixes: ["src/created"],
      authorized_create_prefixes: ["src/created"],
      changed_paths: [],
      execution_context: {
        approved_baseline: {
          file_checksums: { "src/a.js": null, "src/b.js": null },
          authorized_create_prefixes: ["src/created"],
          mutable_file_budget: 2
        }
      }
    };
    baseContext.file_access_policy = issueExecutionFileAccess({
      context: baseContext,
      readPaths: ["AGENTS.md"],
      readPrefixes: ["src", "workflows"],
      policyIdentity,
      authorizeCurrent: () => true
    });
    baseContext.file_access_version = 2;

    const lockedBound = bindEngineeringTools({ registry: {}, context: baseContext });
    await assert.rejects(() => lockedBound.registry.delete_file.execute({ path: "src/a.js", before_checksum: sha256("a") }), { code: "TOOL_LOCKED" });
    await assert.rejects(() => lockedBound.registry.move_file.execute({ from_path: "src/a.js", to_path: "src/created/c.js", before_checksum: sha256("a") }), { code: "TOOL_LOCKED" });

    const mockRegistry = {
      delete_file: { execute: async (input, ctx) => { ctx.changed_paths.push(input.path); return { deleted: true }; } },
      move_file: { execute: async (input, ctx) => { ctx.changed_paths.push(input.from_path, input.to_path); return { moved: true }; } }
    };
    const bound = bindEngineeringTools({ registry: mockRegistry, context: baseContext });
    await bound.registry.delete_file.execute({ path: "workflows/agents/coder/README.md", before_checksum: sha256("a") });
    await bound.registry.delete_file.execute({ path: "AGENTS.md", before_checksum: sha256("a") });
    await bound.registry.move_file.execute({ from_path: "src/a.js", to_path: "src/created/c.js", before_checksum: sha256("a") });
    assert.equal(bound.context.changed_paths.length, 4);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

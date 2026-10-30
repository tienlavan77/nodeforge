// Verifies SE can manage project Forge state across providers while other roles and host paths remain protected.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";

for (const provider of ["codex", "claude"]) {
  test(`${provider} SE discovers, reads, edits and deletes Forge state through the shared tools`, async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "nf-se-forge-"));
    try {
      await mkdir(join(projectRoot, ".forge/config"), { recursive: true });
      await mkdir(join(projectRoot, "src"));
      await writeFile(join(projectRoot, "src/example.js"), "// Existing source.\n");
      const path = ".forge/config/.settings.json";
      const context = { task_id: "SE-FORGE", project_wide_access: true, project_root: projectRoot, agent_identity: { agent_id: "se", role: "system_engineer", provider } };
      const tools = createOwnerConversationTools({ role: "system_engineer", projectRoot, fileService: createFileService({ projectRoot }), codeCache: { read: () => { throw new Error("Runtime reads must bypass the code index."); }, invalidate() {} }, context });
      context.capabilities = tools.definitions.map(({ name }) => name);
      assert.match(tools.definitions.find(({ name }) => name === "search_text").input_schema.properties.paths.items.pattern, /forge/);
      await tools.registry.write_diff.execute({ path, content: '{"enabled":true}\n', before_checksum: null });
      const file = await tools.registry.read_file.execute({ path, offset: 1, limit: 10 });
      assert.match(file.content, /true/);
      assert.match((await tools.registry.read_lines.execute({ path, start_line: 1, end_line: 1 })).stdout, /true/);
      assert.ok((await tools.registry.search_tree.execute({ path: ".forge" })).entries.some((entry) => entry.path === path));
      assert.match((await tools.registry.list_files.execute({})).stdout, /\.forge\/config\/\.settings.json/);
      assert.match((await tools.registry.search_text.execute({ pattern: "enabled", paths: [".forge"], flags: ["-n"] })).stdout, /enabled/);
      await tools.registry.edit_diff.execute({ path, anchor: "true", replacement: "false", before_checksum: file.sha256 });
      assert.match(await readFile(join(projectRoot, path), "utf8"), /false/);
      const updated = await tools.registry.read_file.execute({ path, offset: 1, limit: 10 });
      await assert.rejects(() => tools.registry.delete_file.execute({ path, before_checksum: file.sha256 }), { code: "CHECKSUM_MISMATCH" });
      await tools.registry.delete_file.execute({ path, before_checksum: updated.sha256 });
      await assert.rejects(() => readFile(join(projectRoot, path)), { code: "ENOENT" });
      await assert.rejects(() => tools.registry.write_diff.execute({ path: ".forge/../../escape.json", content: "{}", before_checksum: null }), { code: "TOOL_FORBIDDEN" });
      await assert.rejects(() => tools.registry.write_diff.execute({ path: ".forge-other/escape.json", content: "{}", before_checksum: null }), { code: "TOOL_FORBIDDEN" });
    } finally { await rm(projectRoot, { recursive: true, force: true }); }
  });
}

test("SE Forge access includes hidden runtime files but rejects symlinks and retains other roles' boundaries", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-se-forge-policy-"));
  const outside = await mkdtemp(join(tmpdir(), "nf-se-forge-outside-"));
  try {
    const fileService = createFileService({ projectRoot });
    const se = createRoleFileService({ fileService, projectRoot, role: "system_engineer" });
    await se.atomicWrite({ path: ".forge/config/.env", content: "EXAMPLE=fixture", replace: true });
    assert.equal(await se.readFile({ path: ".forge/config/.env" }), "EXAMPLE=fixture");
    for (const role of ["architecture_manager", "coder", "sprint_leader", "reviewer"]) {
      const scoped = createRoleFileService({ fileService, projectRoot, role });
      await assert.rejects(() => scoped.readFile({ path: ".forge/config/.env" }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(() => scoped.atomicWrite({ path: ".forge/runtime/change.json", content: "{}" }), { code: "FILE_ROLE_FORBIDDEN" });
    }
    await symlink(outside, join(projectRoot, ".forge/linked"));
    await assert.rejects(() => se.atomicWrite({ path: ".forge/linked/file.json", content: "{}" }), { code: "FILE_ROLE_FORBIDDEN" });
    await assert.rejects(() => se.deleteFile({ path: "AGENTS.md" }), { code: "FILE_ROLE_FORBIDDEN" });
  } finally { await rm(projectRoot, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

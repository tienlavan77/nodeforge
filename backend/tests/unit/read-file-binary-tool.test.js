// Purpose: Verifies the read_file_binary Forge tool for Architecture Manager and System Engineer while ensuring other roles are denied.
// Business purpose: Confirms that only AM and SE can read binary files by path with verified sha256 and base64 payloads, and that Coder, Reviewer, Sprint Leader, and Linguist cannot access or execute read_file_binary.
// Technical description: Tests ownerRoleTools policy, createOwnerConversationTools definitions/registry across roles, binary byte reading via createOwnerReadFileBinaryTool, path traversal rejection, and activity/compaction integration.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createOwnerReadFileBinaryTool } from "../../src/tools/roles/owner-read-file-binary.js";
import { authorizeOwnerTool, ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";
import { formatForgeToolActivitySummary, formatForgeToolCommand } from "../../src/application/system-engineer-sdk-transcript.js";

test("ownerRoleTools grants read_file_binary only to architecture_manager and system_engineer", () => {
  assert.equal(ownerRoleTools("architecture_manager").includes("read_file_binary"), true);
  assert.equal(ownerRoleTools("system_engineer").includes("read_file_binary"), true);
  for (const role of ["sprint_leader", "coder", "reviewer", "linguist", "runtime"]) {
    assert.equal(ownerRoleTools(role).includes("read_file_binary"), false, `Expected ${role} not to include read_file_binary`);
  }
});

test("createOwnerConversationTools exposes read_file_binary only for AM and SE and blocks other roles", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nf-read-binary-"));
  try {
    const sampleBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    writeFileSync(join(dir, "asset.bin"), sampleBytes);
    const expectedSha = `sha256:${createHash("sha256").update(sampleBytes).digest("hex")}`;
    const fileService = createFileService({ projectRoot: dir });

    for (const role of ["architecture_manager", "system_engineer"]) {
      const context = {
        task_id: `TASK-${role}`,
        capabilities: [...ownerRoleTools(role)],
        agent_identity: { agent_id: `agent-${role}`, role }
      };
      const { definitions, registry } = createOwnerConversationTools({
        role,
        projectRoot: dir,
        fileService,
        context
      });
      assert.equal(definitions.some(({ name }) => name === "read_file_binary"), true);
      assert.equal(typeof registry.read_file_binary?.execute, "function");

      const result = await registry.read_file_binary.execute({ path: "asset.bin" }, context);
      assert.deepEqual(result, {
        path: "asset.bin",
        sha256: expectedSha,
        size_bytes: sampleBytes.byteLength,
        binary: true,
        encoding: "base64",
        content_base64: sampleBytes.toString("base64")
      });
    }

    for (const role of ["sprint_leader", "coder", "reviewer", "linguist"]) {
      const context = {
        task_id: `TASK-${role}`,
        capabilities: [...ownerRoleTools(role), "read_file_binary"],
        agent_identity: { agent_id: `agent-${role}`, role }
      };
      const { definitions, registry } = createOwnerConversationTools({
        role,
        projectRoot: dir,
        fileService,
        context
      });
      assert.equal(definitions.some(({ name }) => name === "read_file_binary"), false);
      assert.equal(registry.read_file_binary, undefined);
      await assert.rejects(
        () => authorizeOwnerTool("read_file_binary", { path: "asset.bin" }, context, dir),
        { code: "TOOL_FORBIDDEN" }
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read_file_binary validates input arguments, blocks path traversal, and rejects unauthorized roles directly", async () => {
  const tool = createOwnerReadFileBinaryTool({
    fileService: {
      readFile: async () => Buffer.from([1, 2, 3, 4])
    }
  });
  const seContext = { agent_identity: { role: "system_engineer" } };

  await assert.rejects(
    () => tool.execute({ path: "asset.bin" }, { agent_identity: { role: "coder" } }),
    { code: "TOOL_FORBIDDEN" }
  );
  await assert.rejects(
    () => tool.execute({ path: "asset.bin", extra: true }, seContext),
    { code: "INPUT_INVALID" }
  );
  await assert.rejects(
    () => tool.execute({ path: "../secret.bin" }, seContext),
    { code: "PATH_FORBIDDEN" }
  );
  await assert.rejects(
    () => tool.execute({ path: "/abs/secret.bin" }, seContext),
    { code: "PATH_FORBIDDEN" }
  );

  assert.equal(
    formatForgeToolCommand("read_file_binary", { path: "docs/diagram.png" }),
    "read_file_binary docs/diagram.png (binary)"
  );
  assert.match(
    formatForgeToolActivitySummary("read_file_binary", { path: "docs/diagram.png" }, "success", { sha256: "sha256:1234567890abcdef1234567890abcdef" }, 5),
    /Forge tool read_file_binary success: read_file_binary docs\/diagram\.png \(binary\)/
  );
});

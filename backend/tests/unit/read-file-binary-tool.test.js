// Purpose: Verifies that read_file returns binary payload (base64 + sha256) for binary files and metadata for code/text files.
// Business purpose: Confirms that read_file merges binary reading directly so agents can inspect binary assets or code metadata through a single unified read_file tool.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ownerRoleTools } from "../../src/tools/roles/owner-role-tool-policy.js";
import { createOwnerConversationTools } from "../../src/tools/roles/owner-conversation-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReadFileTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

test("ownerRoleTools exposes unified read_file without separate read_file_binary", () => {
  for (const role of ["architecture_manager", "system_engineer", "coder", "reviewer", "sprint_leader", "linguist"]) {
    assert.equal(ownerRoleTools(role).includes("read_file"), true);
    assert.equal(ownerRoleTools(role).includes("read_file_binary"), false);
  }
});

test("read_file returns binary base64 payload for binary files and metadata for code files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nf-read-file-binary-"));
  try {
    const rawBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x10, 0x20]);
    const expectedSha = `sha256:${createHash("sha256").update(rawBytes).digest("hex")}`;
    await writeFile(join(dir, "asset.bin"), rawBytes);
    await writeFile(join(dir, "custom.dat"), rawBytes);
    await writeFile(join(dir, "index.js"), "export function hello() {\n  return 1;\n}\n");

    const fileService = createFileService({ projectRoot: dir });
    for (const role of ["architecture_manager", "system_engineer"]) {
      const context = {
        task_id: `TEST-${role}`,
        agent_identity: { agent_id: `ag-${role}`, role },
        capabilities: ownerRoleTools(role)
      };
      const { definitions, registry } = createOwnerConversationTools({
        role,
        projectRoot: dir,
        fileService,
        context
      });
      assert.equal(definitions.some(({ name }) => name === "read_file"), true);
      assert.equal(definitions.some(({ name }) => name === "read_file_binary"), false);

      const binaryResult = await registry.read_file.execute({ path: "asset.bin" }, context);
      assert.deepEqual(binaryResult, {
        path: "asset.bin",
        sha256: expectedSha,
        size_bytes: rawBytes.byteLength,
        binary: true,
        encoding: "base64",
        content_base64: rawBytes.toString("base64")
      });

      const fallbackBinaryResult = await registry.read_file.execute({ path: "custom.dat" }, context);
      assert.deepEqual(fallbackBinaryResult, {
        path: "custom.dat",
        sha256: expectedSha,
        size_bytes: rawBytes.byteLength,
        binary: true,
        encoding: "base64",
        content_base64: rawBytes.toString("base64")
      });

      const codeResult = await registry.read_file.execute({ path: "index.js" }, context);
      assert.equal(codeResult.path, "index.js");
      assert.equal(codeResult.binary, undefined);
      assert.equal(Array.isArray(codeResult.symbol_map), true);
      assert.equal(codeResult.symbol_map.some((s) => s.name === "hello"), true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("read_file validates input arguments and blocks path traversal on binary and code paths", async () => {
  const rawBytes = Buffer.from([0x01, 0x02, 0x03]);
  const tool = createReadFileTool({
    fileService: {
      readFile: async () => rawBytes,
      readForIndex: async () => ({ content: "export const x = 1;\n" })
    }
  });
  const seContext = { agent_identity: { role: "system_engineer" } };

  await assert.rejects(
    () => tool.execute({ path: "asset.bin", extra: true }, seContext),
    (err) => err?.code === "INPUT_INVALID"
  );
  await assert.rejects(
    () => tool.execute({ path: "../secret.bin" }, seContext),
    (err) => err?.code === "PATH_FORBIDDEN"
  );
  await assert.rejects(
    () => tool.execute({ path: "/abs/secret.bin" }, seContext),
    (err) => err?.code === "PATH_FORBIDDEN"
  );
});

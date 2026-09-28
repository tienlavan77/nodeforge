// Verifies coder edits can update schemas without exposing project documentation.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createEditDiffTool, createReadFileTool, createWriteDiffTool } from "../../src/tools/agent-lifecycle-tools.js";

// Allows schema edits and refuses documentation reads and writes for a coder.
test("coder can edit schemas but cannot access docs", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-coder-scope-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    await fileService.atomicWrite({ path: "schemas/example.json", content: '{"old":true}\n', replace: true });
    await fileService.atomicWrite({ path: "docs/guide.md", content: "Guide\n", replace: true });
    const context = { agent_identity: { role: "coder" }, allowed_prefixes: ["schemas/", "docs/"] };
    const read = createReadFileTool({ fileService });
    const schema = await read.execute({ path: "schemas/example.json" }, context);
    await createEditDiffTool({ fileService }).execute({ path: "schemas/example.json", before_checksum: schema.sha256, anchor: "true", replacement: "false" }, context);
    await assert.rejects(() => read.execute({ path: "docs/guide.md" }, context), (error) => error.code === "PATH_FORBIDDEN");
    await assert.rejects(() => createWriteDiffTool({ fileService }).execute({ path: "docs/new.md", before_checksum: null, content: "Guide\n" }, context), (error) => error.code === "PATH_FORBIDDEN");
  } finally { await rm(root, { recursive: true, force: true }); }
});

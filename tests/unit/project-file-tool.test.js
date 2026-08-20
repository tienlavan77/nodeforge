import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectFileTool } from "../../src/modules/agent/project-file-tool.js";

test("writes a project-scoped file from a task query", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-file-tool-"));
  try {
    const tool = createProjectFileTool({ projectRoot: root });
    await tool.writeFromQuery("create src/e2e-smoke2.txt with hello");
    assert.equal(await readFile(join(root, "src/e2e-smoke2.txt"), "utf8"), "hello");
    await assert.rejects(() => tool.writeFile({ path: "../escape.txt", content: "x" }));
    await assert.rejects(() => tool.writeFile({ path: ".env", content: "SECRET=x" }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

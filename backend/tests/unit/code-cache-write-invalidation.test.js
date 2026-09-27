// Verifies failed Forge writes retain the last valid cache entry.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createWriteDiffTool } from "../../src/tools/agent-lifecycle-tools.js";

// Keeps source cached when an atomic write fails after checksum validation.
test("write failure does not invalidate a previously cached entry", async () => {
  const content = "const value = 1;\n";
  const cache = { invalidated: [], invalidate: (input) => cache.invalidated.push(input) };
  const fileService = { readFile: async () => content, atomicWrite: async () => { throw new Error("disk full"); } };
  const tool = createWriteDiffTool({ fileService, codeCache: cache });
  const before_checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  await assert.rejects(() => tool.execute({ path: "safe.js", before_checksum, content: "const value = 2;\n" }, {}), /disk full/);
  assert.deepEqual(cache.invalidated, []);
});

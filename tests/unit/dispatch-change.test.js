import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionContext } from "../../src/application/execution-layer.js";
import { dispatchChange } from "../../src/application/dispatch-change.js";

const checksum = (content) => `sha256:${createHash("sha256").update(content).digest("hex")}`;
async function setup(content = "alpha\nbeta\n") {
  const dir = await mkdtemp(join(os.tmpdir(), "forge-dispatch-"));
  const filePath = join(dir, "file.txt");
  await writeFile(filePath, content);
  return { dir, filePath, content };
}
function context(change, trace = []) { return createExecutionContext({ taskId: "task-1", stepId: 1, change, trace }); }

test("routes unified diff and records checksum then handler", async () => {
  const f = await setup();
  try {
    const result = await dispatchChange(context({ file_path: f.filePath, checksum_before: checksum(f.content), diff: "--- file\n+++ file\n@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n" }));
    assert.equal(result.trace.length, 2); assert.equal(result.trace[0].step_name, "verifyChecksum"); assert.equal(result.trace[1].step_name, "applyUnifiedDiff");
    assert.equal(await readFile(f.filePath, "utf8"), "alpha\ngamma\n");
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("routes search-replace, full-file, and structured patch", async (t) => {
  for (const [name, change, expected] of [
    ["search", (p, c) => ({ file_path: p, checksum_before: checksum(c), old_str: "beta", new_str: "gamma" }), "alpha\ngamma\n"],
    ["full", (p, c) => ({ file_path: p, checksum_before: checksum(c), content: "replaced\n" }), "replaced\n"],
    ["structured", (p, c) => ({ file_path: p, checksum_before: checksum(c), operations: [{ type: "replace_lines", start: 2, end: 2, new_content: "gamma" }] }), "alpha\ngamma\n"]
  ]) {
    await t.test(name, async () => { const f = await setup(); try { const result = await dispatchChange(context(change(f.filePath, f.content))); assert.equal(result.trace.length, 2); assert.equal(result.trace[1].success, true); assert.equal(await readFile(f.filePath, "utf8"), expected); } finally { await rm(f.dir, { recursive: true, force: true }); } });
  }
});

test("stops on checksum mismatch without invoking a handler", async () => {
  const f = await setup();
  try { const result = await dispatchChange(context({ file_path: f.filePath, checksum_before: "sha256:wrong", content: "changed" })); assert.equal(result.trace.length, 1); assert.equal(result.trace[0].error_code, "CHECKSUM_MISMATCH"); assert.equal(await readFile(f.filePath, "utf8"), f.content); } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("returns PATCH_NOT_APPLICABLE for an unknown change", async () => {
  const f = await setup();
  try { const result = await dispatchChange(context({ file_path: f.filePath, checksum_before: checksum(f.content), note: "unknown" })); assert.equal(result.trace.length, 2); assert.equal(result.trace[1].error_code, "PATCH_NOT_APPLICABLE"); } finally { await rm(f.dir, { recursive: true, force: true }); }
});

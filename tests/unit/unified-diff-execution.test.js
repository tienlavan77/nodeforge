import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyUnifiedDiff } from "../../src/application/execution-handlers/unified-diff.js";

const diff = (oldText = "two", newText = "TWO") => `--- a/file.txt\n+++ b/file.txt\n@@ -1,3 +1,3 @@\n one\n-${oldText}\n+${newText}\n three\n`;

async function fixture(content = "one\ntwo\nthree\n") { const directory = await mkdtemp(join(os.tmpdir(), "forge-unified-diff-")); const filePath = join(directory, "file.txt"); await writeFile(filePath, content); return { directory, filePath }; }

test("applies a matching unified diff", async () => { const { directory, filePath } = await fixture(); try { const result = await applyUnifiedDiff(filePath, diff()); assert.equal(result.success, true); assert.equal(await readFile(filePath, "utf8"), "one\nTWO\nthree\n"); } finally { await rm(directory, { recursive: true, force: true }); } });
test("rejects a context mismatch", async () => { const { directory, filePath } = await fixture("one\nchanged\nthree\n"); try { const result = await applyUnifiedDiff(filePath, diff()); assert.equal(result.success, false); assert.equal(result.error_code, "PATCH_NOT_APPLICABLE"); } finally { await rm(directory, { recursive: true, force: true }); } });
test("dry_run returns content without backup or write", async () => { const { directory, filePath } = await fixture(); let called = false; try { const result = await applyUnifiedDiff(filePath, diff(), { dry_run: true, backupFile: async () => { called = true; } }); assert.equal(result.success, true); assert.equal(called, false); assert.equal(result.detail.content, "one\nTWO\nthree\n"); assert.equal(await readFile(filePath, "utf8"), "one\ntwo\nthree\n"); } finally { await rm(directory, { recursive: true, force: true }); } });
test("backup failure stops before writing", async () => { const { directory, filePath } = await fixture(); try { const result = await applyUnifiedDiff(filePath, diff(), { backupFile: async () => ({ step_name: "backupFile", success: false, error_code: "IO_ERROR", error_message: "no backup" }) }); assert.equal(result.success, false); assert.equal(result.error_code, "IO_ERROR"); assert.equal(await readFile(filePath, "utf8"), "one\ntwo\nthree\n"); } finally { await rm(directory, { recursive: true, force: true }); } });

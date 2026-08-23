import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyFullFileReplace } from "../../src/application/execution-handlers/full-file-replace.js";

async function fixture(content = "original\n") {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-full-replace-"));
  const filePath = join(directory, "source.txt");
  await writeFile(filePath, content, "utf8");
  return { directory, filePath };
}

test("replaces content after creating a backup", async () => {
  const { directory, filePath } = await fixture();
  try {
    const result = await applyFullFileReplace(filePath, "replacement\n");
    assert.equal(result.success, true);
    assert.equal(result.step_name, "applyFullFileReplace");
    assert.equal(typeof result.detail.backup_ref, "string");
    assert.equal(await readFile(filePath, "utf8"), "replacement\n");
    assert.equal(await readFile(result.detail.backup_ref, "utf8"), "original\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dry_run does not backup or write", async () => {
  const { directory, filePath } = await fixture();
  let called = false;
  try {
    const result = await applyFullFileReplace(filePath, "replacement\n", { dry_run: true, backupFile: async () => { called = true; throw new Error("must not call"); } });
    assert.equal(result.success, true);
    assert.equal(called, false);
    assert.equal(await readFile(filePath, "utf8"), "original\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing file returns IO_ERROR before writing", async () => {
  const { directory, filePath } = await fixture();
  await rm(filePath);
  try {
    const result = await applyFullFileReplace(filePath, "replacement\n");
    assert.equal(result.success, false);
    assert.equal(result.error_code, "IO_ERROR");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("returns backup failure and does not overwrite the original", async () => {
  const { directory, filePath } = await fixture();
  const backupError = { step_name: "backupFile", success: false, error_code: "IO_ERROR", error_message: "backup unavailable" };
  try {
    const result = await applyFullFileReplace(filePath, "replacement\n", { backupFile: async () => backupError });
    assert.deepEqual(result, backupError);
    assert.equal(await readFile(filePath, "utf8"), "original\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

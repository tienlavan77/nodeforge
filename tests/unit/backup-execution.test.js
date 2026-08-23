import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { backupFile, rollbackFile } from "../../src/application/execution-handlers/backup.js";

async function fixture(content = "original\n") {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-backup-"));
  const filePath = join(directory, "source.txt");
  await writeFile(filePath, content, "utf8");
  return { directory, filePath };
}

test("backupFile creates a snapshot with matching content", async () => {
  const { directory, filePath } = await fixture("before\n");
  try {
    const result = await backupFile(filePath);
    assert.equal(result.success, true);
    assert.equal(result.step_name, "backupFile");
    assert.equal(await readFile(result.detail.backup_ref, "utf8"), "before\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("backupFile returns IO_ERROR for a missing source", async () => {
  const { directory, filePath } = await fixture();
  await rm(filePath);
  try {
    const result = await backupFile(filePath);
    assert.equal(result.success, false);
    assert.equal(result.error_code, "IO_ERROR");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rollbackFile restores the original content", async () => {
  const { directory, filePath } = await fixture("original\n");
  try {
    const backup = await backupFile(filePath);
    await writeFile(filePath, "changed\n", "utf8");
    const result = await rollbackFile(filePath, backup.detail.backup_ref);
    assert.equal(result.success, true);
    assert.equal(result.step_name, "rollbackFile");
    assert.equal(await readFile(filePath, "utf8"), "original\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rollbackFile returns IO_ERROR for a missing backup", async () => {
  const { directory, filePath } = await fixture();
  try {
    const result = await rollbackFile(filePath, join(directory, "missing-backup.txt"));
    assert.equal(result.success, false);
    assert.equal(result.error_code, "IO_ERROR");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

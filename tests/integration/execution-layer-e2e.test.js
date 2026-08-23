import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExecutionContext } from "../../src/application/execution-layer.js";
import { dispatchChange } from "../../src/application/dispatch-change.js";
import { rollbackFile } from "../../src/application/execution-handlers/backup.js";

const digest = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
async function fixture(content) {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-execution-e2e-"));
  const filePath = join(directory, "sample.txt");
  await writeFile(filePath, content);
  return { directory, filePath };
}
const contextFor = (change) => createExecutionContext({ taskId: "e2e-task", stepId: 1, change });

test("dispatchChange applies search/replace, preserves backup, and records ordered trace", async () => {
  const original = "before\nkeep\n";
  const fixtureData = await fixture(original);
  try {
    const result = await dispatchChange(contextFor({ file_path: fixtureData.filePath, checksum_before: digest(original), old_str: "before", new_str: "after" }));
    assert.equal(await readFile(fixtureData.filePath, "utf8"), "after\nkeep\n");
    assert.deepEqual(result.trace.map((entry) => entry.step_name), ["verifyChecksum", "applySearchReplaceBlock"]);
    const backupRef = result.trace[1].detail.backup_ref;
    await access(backupRef);
    assert.equal(await readFile(backupRef, "utf8"), original);

    // Simulate a later verification failure and restore through the real rollback path.
    await writeFile(fixtureData.filePath, "verification failure\n");
    const rollback = await rollbackFile(fixtureData.filePath, backupRef);
    assert.equal(rollback.success, true);
    assert.equal(rollback.step_name, "rollbackFile");
    assert.equal(await readFile(fixtureData.filePath, "utf8"), original);
  } finally { await rm(fixtureData.directory, { recursive: true, force: true }); }
});

test("dispatchChange stops on an invalid checksum without changing the file", async () => {
  const original = "before\n";
  const fixtureData = await fixture(original);
  try {
    const result = await dispatchChange(contextFor({ file_path: fixtureData.filePath, checksum_before: "sha256:invalid", old_str: "before", new_str: "after" }));
    assert.equal(await readFile(fixtureData.filePath, "utf8"), original);
    assert.equal(result.trace.length, 1);
    assert.equal(result.trace[0].step_name, "verifyChecksum");
    assert.equal(result.trace[0].error_code, "CHECKSUM_MISMATCH");
  } finally { await rm(fixtureData.directory, { recursive: true, force: true }); }
});

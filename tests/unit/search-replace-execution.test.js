import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applySearchReplaceBlock } from "../../src/application/execution-handlers/search-replace.js";

async function fixture(content) {
  const directory = await mkdtemp(join(os.tmpdir(), "forge-search-replace-"));
  const filePath = join(directory, "fixture.txt");
  await writeFile(filePath, content, "utf8");
  return { directory, filePath };
}

test("replaces one exact match and writes the file", async () => {
  const { directory, filePath } = await fixture("before\nneedle\nafter\n");
  try {
    const result = await applySearchReplaceBlock(filePath, "needle", "changed");
    assert.equal(result.step_name, "applySearchReplaceBlock");
    assert.equal(result.success, true);
    assert.equal(result.error_code, null);
    assert.equal(await readFile(filePath, "utf8"), "before\nchanged\nafter\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("returns NO_MATCH without writing", async () => {
  const { directory, filePath } = await fixture("unchanged\n");
  try {
    const result = await applySearchReplaceBlock(filePath, "missing", "changed");
    assert.equal(result.success, false);
    assert.equal(result.error_code, "NO_MATCH");
    assert.equal(await readFile(filePath, "utf8"), "unchanged\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("returns AMBIGUOUS_MATCH when the exact string occurs more than once", async () => {
  const { directory, filePath } = await fixture("needle\nkeep\nneedle\n");
  try {
    const result = await applySearchReplaceBlock(filePath, "needle", "changed");
    assert.equal(result.success, false);
    assert.equal(result.error_code, "AMBIGUOUS_MATCH");
    assert.equal(await readFile(filePath, "utf8"), "needle\nkeep\nneedle\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("dry_run reports the replacement without writing", async () => {
  const { directory, filePath } = await fixture("needle\n");
  try {
    const result = await applySearchReplaceBlock(filePath, "needle", "changed", { dry_run: true });
    assert.equal(result.success, true);
    assert.equal(result.detail.dry_run, true);
    assert.equal(await readFile(filePath, "utf8"), "needle\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

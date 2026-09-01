import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyApplyPatch } from "../../src/application/execution-handlers/apply-patch.js";

async function fixture(content) {
  const dir = await mkdtemp(join(tmpdir(), "nodeforge-apply-patch-"));
  const file = join(dir, "example.js");
  await writeFile(file, content);
  return { dir, file };
}

test("applies an apply_patch hunk using surrounding context", async () => {
  const current = await fixture("export const before = true;\nexport const value = 1;\n");
  try {
    const patch = `*** Begin Patch\n*** Update File: ${current.file}\n@@\n export const before = true;\n-export const value = 1;\n+export const value = 2;\n*** End Patch`;
    const result = await applyApplyPatch(current.file, patch);
    assert.equal(result.success, true);
    assert.equal(await readFile(current.file, "utf8"), "export const before = true;\nexport const value = 2;\n");
  } finally { await rm(current.dir, { recursive: true, force: true }); }
});

test("rejects additions-only hunks without a location", async () => {
  const current = await fixture("export const value = 1;\n");
  try {
    const patch = `*** Begin Patch\n*** Update File: ${current.file}\n@@\n+export const other = 2;\n*** End Patch`;
    const result = await applyApplyPatch(current.file, patch);
    assert.equal(result.success, false);
    assert.match(result.error_message, /additions only/);
  } finally { await rm(current.dir, { recursive: true, force: true }); }
});

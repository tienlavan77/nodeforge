import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyChecksum } from "../../src/application/execution-handlers/verify-checksum.js";

async function fixture(content = "checksum me\n") { const directory = await mkdtemp(join(os.tmpdir(), "forge-checksum-")); const filePath = join(directory, "file.txt"); await writeFile(filePath, content); return { directory, filePath, checksum: `sha256:${createHash("sha256").update(content).digest("hex")}` }; }

test("accepts a matching SHA-256 checksum", async () => { const { directory, filePath, checksum } = await fixture(); try { const result = await verifyChecksum(filePath, checksum); assert.equal(result.success, true); assert.equal(result.step_name, "verifyChecksum"); assert.equal(result.error_code, null); } finally { await rm(directory, { recursive: true, force: true }); } });
test("returns CHECKSUM_MISMATCH with expected and actual values", async () => { const { directory, filePath } = await fixture(); try { const result = await verifyChecksum(filePath, "sha256:wrong"); assert.equal(result.success, false); assert.equal(result.error_code, "CHECKSUM_MISMATCH"); assert.equal(result.detail.expected, "sha256:wrong"); assert.match(result.detail.actual, /^sha256:[a-f0-9]{64}$/); } finally { await rm(directory, { recursive: true, force: true }); } });
test("returns IO_ERROR for a missing file", async () => { const { directory, filePath, checksum } = await fixture(); await rm(filePath); try { const result = await verifyChecksum(filePath, checksum); assert.equal(result.success, false); assert.equal(result.error_code, "IO_ERROR"); } finally { await rm(directory, { recursive: true, force: true }); } });

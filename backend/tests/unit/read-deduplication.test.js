// Verifies shared Forge read deduplication behavior so repeated agent discovery does not reread unchanged project evidence.
// Business purpose: protect provider context and repository latency while preserving checksum-aware invalidation for engineering work.
import test from "node:test";
import assert from "node:assert/strict";
import { invalidateReadDeduplication, readDeduplicationKey, readWithDeduplication } from "../../src/tools/discovery/read-deduplication.js";

test("shares an in-flight read and marks the second caller as deduplicated", async () => {
  const key = readDeduplicationKey({ projectRoot: "/project", projectId: "p", conversationId: "c", delegationId: "d", path: "src/a.js", tool: "source", symbol: "run" });
  let reads = 0;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const read = async () => { reads += 1; await pending; return { path: "src/a.js", sha256: "sha256:a" }; };
  const first = readWithDeduplication({ key, path: "src/a.js", read });
  const second = readWithDeduplication({ key, path: "src/a.js", read });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(reads, 1);
  assert.equal(a.read_deduplication.status, "executed");
  assert.equal(b.read_deduplication.status, "deduplicated");
});

test("returns a completed cache hit for unchanged observed evidence", async () => {
  const key = readDeduplicationKey({ projectRoot: "/project", projectId: "p", conversationId: "c2", delegationId: "d2", path: "src/b.js", tool: "source", symbol: "run" });
  let reads = 0;
  const read = async () => ({ path: "src/b.js", sha256: "sha256:b", content: "ok" });
  await readWithDeduplication({ key, path: "src/b.js", read: () => { reads += 1; return read(); } });
  const result = await readWithDeduplication({ key, path: "src/b.js", context: { observed_files: [{ path: "src/b.js", sha256: "sha256:b" }] }, read: () => { reads += 1; return read(); } });
  assert.equal(reads, 1);
  assert.equal(result.read_deduplication.status, "cache_hit");
});

test("invalidates cached reads after a path mutation", async () => {
  const key = readDeduplicationKey({ projectRoot: "/project", projectId: "p", conversationId: "c3", delegationId: "d3", path: "src/c.js", tool: "source", symbol: "run" });
  let reads = 0;
  const read = async () => ({ path: "src/c.js", sha256: `sha256:c${reads}` });
  await readWithDeduplication({ key, path: "src/c.js", read: () => { reads += 1; return read(); } });
  invalidateReadDeduplication({ projectRoot: "/project", projectId: "p", path: "src/c.js" });
  const result = await readWithDeduplication({ key, path: "src/c.js", read: () => { reads += 1; return read(); } });
  assert.equal(reads, 2);
  assert.equal(result.read_deduplication.status, "executed");
});

test("does not reuse a cached result when observed checksum changed", async () => {
  const key = readDeduplicationKey({ projectRoot: "/project", projectId: "p", conversationId: "c4", delegationId: "d4", path: "src/d.js", tool: "source", symbol: "run" });
  let reads = 0;
  const read = async () => ({ path: "src/d.js", sha256: "sha256:d" });
  await readWithDeduplication({ key, path: "src/d.js", read: () => { reads += 1; return read(); } });
  const result = await readWithDeduplication({ key, path: "src/d.js", context: { observed_files: [{ path: "src/d.js", sha256: "sha256:changed" }] }, read: () => { reads += 1; return read(); } });
  assert.equal(reads, 2);
  assert.equal(result.read_deduplication.status, "executed");
});

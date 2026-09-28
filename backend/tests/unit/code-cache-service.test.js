// Verifies project code cache freshness, bounded memory, and source visibility for agents.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";
import { createReadFileTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createSearchCodeTool } from "../../src/tools/search-code.js";
import { createClaudeFileTools } from "../../src/tools/claude-file-tools.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Provides mutable project files and counts underlying reads for cache assertions.
function fixture(initial) {
  const files = new Map(Object.entries(initial));
  const reads = [];
  const fileService = { async readForIndex({ path }) {
    reads.push(path);
    if (!files.has(path)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    const content = files.get(path);
    return { content, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}`, language: "js" };
  } };
  return { files, reads, fileService };
}

test("cache hit, TTL and FIFO retain insertion order after a hit", async () => {
  const { reads, fileService } = fixture({ "a.js": "aa", "b.js": "bb", "c.js": "cc" });
  let now = 1000;
  const cache = createCodeCacheService({ projectId: "P", fileService, clock: () => now, maxBytes: 4, ttlMs: 600000 });
  assert.equal((await cache.read({ path: "a.js" })).cache.status, "miss");
  await cache.read({ path: "b.js" });
  assert.equal((await cache.read({ path: "a.js" })).cache.status, "hit");
  await cache.read({ path: "c.js" });
  assert.equal((await cache.read({ path: "a.js" })).cache.status, "miss");
  assert.deepEqual(reads, ["a.js", "b.js", "c.js", "a.js"]);
  now += 600001;
  assert.equal((await cache.read({ path: "a.js" })).cache.status, "miss");
  cache.close();
  assert.equal(cache.stats().bytes, 0);
  await assert.rejects(cache.read({ path: "a.js" }), /closed/);
});

test("watcher refresh keeps FIFO and TTL, invalidates mismatched changes, and skips unknown files", async () => {
  const { files, reads, fileService } = fixture({ "a.js": "aa", "b.js": "bb", "c.js": "cc" });
  let now = 1000;
  const cache = createCodeCacheService({ projectId: "P", fileService, clock: () => now, maxBytes: 4 });
  await cache.read({ path: "a.js" });
  now += 1;
  await cache.read({ path: "b.js" });
  files.set("a.js", "az");
  assert.equal(await cache.refreshChanged({ path: "a.js" }), "refreshed");
  assert.equal((await cache.read({ path: "a.js" })).cache.expires_at, new Date(601000).toISOString());
  assert.equal(await cache.refreshChanged({ path: "c.js" }), "not_cached");
  assert.equal(reads.includes("c.js"), false);
  await cache.read({ path: "c.js" });
  assert.equal((await cache.read({ path: "a.js" })).cache.status, "miss");
  files.set("a.js", "new");
  assert.equal(await cache.refreshChanged({ path: "a.js", expectedSha256: `sha256:${"0".repeat(64)}` }), "invalidated");
  assert.equal((await cache.read({ path: "a.js" })).content, "new");
});

test("oversize files bypass cache while metadata-only reads hide source and stale symbols", async () => {
  const { files, reads, fileService } = fixture({ "source.js": "function answer() {\n return 42;\n}\n", "large.js": "123456789" });
  const indexSha = `sha256:${createHash("sha256").update(files.get("source.js")).digest("hex")}`;
  const codeSearch = { fileMetadata: () => ({ sha256: indexSha, symbols: [{ name: "answer", start_line: 1, end_line: 3 }], graph: { imports: [], imported_by: [], calls: [] } }) };
  const cache = createCodeCacheService({ projectId: "P", fileService, codeSearch, maxBytes: 8 });
  assert.equal((await cache.read({ path: "large.js" })).cache.status, "bypass");
  assert.equal((await cache.read({ path: "large.js" })).cache.status, "bypass");
  assert.equal(reads.filter((path) => path === "large.js").length, 2);
  const sourceCache = createCodeCacheService({ projectId: "P", fileService, codeSearch });
  const reader = createReadFileTool({ fileService, codeCache: sourceCache });
  const metadata = await reader.execute({ path: "source.js" });
  assert.equal(metadata.content, undefined);
  assert.equal(metadata.index_status, "fresh");
  assert.equal(metadata.symbol_map[0].name, "answer");
  assert.match((await reader.execute({ path: "source.js", symbol: "answer" })).content, /return 42/);
  files.set("source.js", "function answer() {\n return 43;\n}\n");
  await sourceCache.refreshChanged({ path: "source.js" });
  const stale = await reader.execute({ path: "source.js" });
  assert.equal(stale.index_status, "stale");
  assert.deepEqual(stale.symbol_map, []);
  assert.match((await reader.execute({ path: "source.js", symbol: "answer" })).content, /return 43/);
});

test("projects keep separate cache entries and index failure does not block source reads", async () => {
  const left = fixture({ "same.js": "left" });
  const right = fixture({ "same.js": "right" });
  const codeSearch = { fileMetadata: () => { throw new Error("index busy"); } };
  const first = createCodeCacheService({ projectId: "LEFT", fileService: left.fileService, codeSearch });
  const second = createCodeCacheService({ projectId: "RIGHT", fileService: right.fileService });
  assert.equal((await first.read({ path: "same.js" })).index_status, "unavailable");
  assert.equal((await first.read({ path: "same.js" })).content, "left");
  assert.equal((await second.read({ path: "same.js" })).content, "right");
  assert.deepEqual(left.reads, ["same.js"]);
  assert.deepEqual(right.reads, ["same.js"]);
});

test("read_file keeps metadata-only contract without a cache dependency", async () => {
  const { fileService } = fixture({ "sample.js": "function sample() {\n return 1;\n}\n" });
  const reader = createReadFileTool({ fileService });
  const metadata = await reader.execute({ path: "sample.js" });
  assert.equal(metadata.content, undefined);
  assert.equal(metadata.cache.status, "bypass");
  assert.equal(metadata.index_status, "unavailable");
  assert.equal(metadata.symbol_map[0].name, "sample");
  const source = await reader.execute({ path: "sample.js", symbol: "sample" });
  assert.match(source.content, /return 1/);
});

test("search prewarm serves metadata and both coder source readers from one cached File Service read", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-coder-cache-"));
  const path = "backend/example.js";
  const content = "function example() {\n  return 42;\n}\n";
  const sha256 = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, path), content);
    const files = createFileService({ projectRoot: root });
    let reads = 0;
    const fileService = { ...files, readForIndex: async (input) => { reads += 1; return files.readForIndex(input); } };
    const codeSearch = {
      search: async () => ({ matches: [{ node: { path, language: "js", sha256, symbols: [{ name: "example", start_line: 1, end_line: 3 }] }, score: 1, reason: [] }] }),
      fileMetadata: () => ({ sha256, symbols: [{ name: "example", start_line: 1, end_line: 3 }], graph: {} })
    };
    const cache = createCodeCacheService({ projectId: "CODER", fileService, codeSearch });
    const context = { task_id: "CODER-CACHE", agent_identity: { role: "coder" }, capabilities: ["search_code", "sed_lines"], allowed_file_paths: [path], allowed_prefixes: ["backend/"] };
    const search = await createSearchCodeTool({ codeSearch, codeCache: cache }).execute({ query: "example", kind: "file", limit: 1, allowed_prefixes: ["backend/"] }, context);
    assert.equal(search.matches[0].index_status, "fresh");
    assert.equal(reads, 1);
    const metadata = await createReadFileTool({ fileService, codeCache: cache }).execute({ path }, context);
    assert.equal(metadata.cache.status, "hit");
    assert.equal(metadata.content, undefined);
    assert.equal(metadata.symbol_map[0].name, "example");
    const claude = await createClaudeFileTools({ fileService, projectRoot: root, codeCache: cache }).Read.execute({ file_path: path, start_line: 1, end_line: 3 }, context);
    assert.equal(claude.cache.status, "hit");
    assert.match(claude.content, /return 42/);
    const codex = await createSedLinesTool({ projectRoot: root, fileService, codeCache: cache, logger: { emit() {} } }).execute({ path, start_line: 1, end_line: 3 }, context);
    assert.equal(codex.cache.status, "hit");
    assert.match(codex.stdout, /return 42/);
    assert.equal(reads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh invalidates instead of caching content that changes during the refresh read", async () => {
  let call = 0;
  const fileService = { async readForIndex() {
    call += 1;
    const content = call === 1 ? "old" : call === 2 ? "new" : "newer";
    return { content, sha256: `sha256:${createHash("sha256").update(content).digest("hex")}` };
  } };
  const cache = createCodeCacheService({ projectId: "P", fileService });
  await cache.read({ path: "race.js" });
  assert.equal(await cache.refreshChanged({ path: "race.js" }), "invalidated");
  assert.equal(cache.stats().entries, 0);
});

test("File Service policy prevents protected and binary files from entering cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-cache-policy-"));
  try {
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await writeFile(join(root, "binary.bin"), Buffer.from([0, 1, 2]));
    const fileService = createFileService({ projectRoot: root });
    const cache = createCodeCacheService({ projectId: "P", fileService });
    await assert.rejects(cache.read({ path: ".env" }));
    await assert.rejects(cache.read({ path: "binary.bin" }), /binary|invalid/i);
    assert.equal(cache.stats().entries, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

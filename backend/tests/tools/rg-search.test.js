// Verifies scoped project content search, prioritized flags, and runtime logging.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createRgSearchTool } from "../../src/tools/rg-search.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createCodeCacheService } from "../../src/modules/context/code-cache-service.js";

const context = { task_id: "SEARCH-1", capabilities: ["rg_search"], correlation_id: "C-SEARCH" };

// Captures project log events without writing to the test process output.
function captureLogger(events) {
  return createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write() {} } });
}

// Matches source text with line numbers and verifies exact native output.
test("rg_search runs prioritized flags inside approved project paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-search-"));
  try {
    await mkdir(join(root, "backend"));
    await mkdir(join(root, "ui"));
    await writeFile(join(root, "backend", "one.js"), "const SymbolName = 1;\nkeyword here\n");
    await writeFile(join(root, "ui", "two.txt"), "symbolname\n");
    const events = [];
    const tool = createRgSearchTool({ projectRoot: root, logger: captureLogger(events) });
    const input = { pattern: "symbolname", paths: ["backend", "ui"], flags: ["-n", "-i", "-F", "--max-count=2"] };
    const actual = await tool.execute(input, context);
    assert.match(actual.stdout, /backend\/one\.js:1:const SymbolName/);
    assert.match(actual.stdout, /ui\/two\.txt:1:symbolname/);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.rg_search_started", "forge.rg_search_completed"]);
    assert.equal(events[1].payload.command.at(-1), "ui");
    assert.equal(events[1].payload.command.includes("symbolname"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("rg_search reads shared source cache and leaves it available for sed_lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-cache-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "const symbol = 1;\n");
    const base = createFileService({ projectRoot: root });
    let reads = 0;
    const fileService = { ...base, readForIndex: async (input) => { reads += 1; return base.readForIndex(input); } };
    const codeCache = createCodeCacheService({ projectId: "P", fileService });
    const logger = captureLogger([]);
    const scoped = { ...context, capabilities: ["rg_search", "sed_lines"], allowed_file_paths: ["backend/one.js"] };
    const search = await createRgSearchTool({ projectRoot: root, codeCache, logger }).execute({ pattern: "symbol", paths: ["backend"], flags: ["-n"] }, scoped);
    assert.equal(search.stdout, "backend/one.js:1:const symbol = 1;\n");
    assert.equal(reads, 1);
    const repeated = await createRgSearchTool({ projectRoot: root, codeCache, logger }).execute({ pattern: "SYMBOL", paths: ["backend"], flags: ["-n", "-i", "--type=js", "--glob=!*.txt"] }, scoped);
    assert.equal(repeated.stdout, search.stdout);
    assert.equal(reads, 1);
    const lines = await createSedLinesTool({ projectRoot: root, fileService, codeCache, logger }).execute({ path: "backend/one.js", start_line: 1, end_line: 1 }, scoped);
    assert.equal(lines.stdout, "const symbol = 1;\n");
    assert.equal(reads, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Rejects unauthorized, unsafe, ignored, symlink, and unsupported search requests with logs.
test("rg_search rejects unsafe scope and flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-search-invalid-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "keyword\n");
    const events = [];
    const tool = createRgSearchTool({ projectRoot: root, logger: captureLogger(events) });
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["../outside"] }, context), /top-level project directories/);
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["backend"], flags: ["--no-ignore"] }, context), /unsupported flag/);
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["backend"], flags: ["--pre=sh"] }, context), /unsupported flag/);
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["backend"], flags: ["--context=2"] }, context), /unsupported flag/);
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["backend"] }, { task_id: "X", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
    assert.equal(events.length, 5);
    assert.ok(events.every((event) => event.event_name === "forge.rg_search_rejected"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Returns ripgrep's native nonzero result and persists a failure event for invalid regex.
test("rg_search logs ripgrep execution errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-search-error-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "keyword\n");
    const events = [];
    const tool = createRgSearchTool({ projectRoot: root, logger: captureLogger(events) });
    const result = await tool.execute({ pattern: "[", paths: ["backend"] }, context);
    assert.equal(result.exit_code, 2);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.rg_search_started", "forge.rg_search_failed"]);
    assert.equal(events[1].error_code, "RG_SEARCH_EXIT_NONZERO");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Preserves ripgrep syntax errors when source reads use the shared cache.
test("rg_search reports invalid regex with cache enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-cache-error-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "keyword\n");
    const codeCache = createCodeCacheService({ projectId: "P", fileService: createFileService({ projectRoot: root }) });
    const input = { pattern: "[", paths: ["backend"] };
    const expected = await createRgSearchTool({ projectRoot: root, logger: captureLogger([]) }).execute(input, context);
    const result = await createRgSearchTool({ projectRoot: root, codeCache, logger: captureLogger([]) }).execute(input, context);
    assert.equal(result.exit_code, 2);
    assert.match(result.stderr, /regex parse error/);
    assert.equal(result.stderr, expected.stderr);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Compares supported ripgrep output and exit codes across multiple files and flag combinations.
test("rg_search cache preserves native output for case, word, limit and no matches", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-contract-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "Symbol\nsymbolic\nSYMBOL\n");
    await writeFile(join(root, "backend", "two.js"), "symbol\nSYMBOL\n");
    const codeCache = createCodeCacheService({ projectId: "P", fileService: createFileService({ projectRoot: root }) });
    const native = createRgSearchTool({ projectRoot: root, logger: captureLogger([]) });
    const cached = createRgSearchTool({ projectRoot: root, codeCache, logger: captureLogger([]) });
    for (const input of [
      { pattern: "Symbol", paths: ["backend"], flags: [] },
      { pattern: "symbol", paths: ["backend"], flags: ["-n", "-i", "-w"] },
      { pattern: "symbol", paths: ["backend"], flags: ["-n", "-i", "--max-count=1"] },
      { pattern: "symbol", paths: ["backend"], flags: ["-n", "-F", "--type=js", "--glob=!*.txt"] },
      { pattern: "missing", paths: ["backend"], flags: ["-n"] }
    ]) {
      const expected = await native.execute(input, context);
      const actual = await cached.execute(input, context);
      assert.deepEqual(actual, expected);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Ensures a listing race reads only through File Service and skips a deleted file.
test("rg_search handles a file removed or changed after listing", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-rg-list-race-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "one.js"), "old text\n");
    const fileService = createFileService({ projectRoot: root });
    const cache = createCodeCacheService({ projectId: "P", fileService });
    let changed = false;
    const changedCache = { read: async (input) => {
      if (!changed) { changed = true; await writeFile(join(root, input.path), "new text\n"); }
      return cache.read(input);
    } };
    const tool = createRgSearchTool({ projectRoot: root, codeCache: changedCache, logger: captureLogger([]) });
    const updated = await tool.execute({ pattern: "new", paths: ["backend"], flags: ["-n"] }, context);
    assert.equal(updated.stdout, "backend/one.js:1:new text\n");
    await unlink(join(root, "backend", "one.js"));
    cache.invalidate({ path: "backend/one.js" });
    await writeFile(join(root, "backend", "two.js"), "other text\n");
    const removedCache = { read: async (input) => {
      if (input.path === "backend/two.js") { await unlink(join(root, input.path)); }
      return cache.read(input);
    } };
    const events = [];
    const removed = await createRgSearchTool({ projectRoot: root, codeCache: removedCache, logger: captureLogger(events) }).execute({ pattern: "other", paths: ["backend"], flags: ["-n"] }, context);
    assert.equal(removed.exit_code, 1);
    assert.equal(removed.stdout, "");
    assert.ok(events.some((event) => event.event_name === "forge.rg_search_cache_read_skipped" && event.error_code === "ENOENT"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

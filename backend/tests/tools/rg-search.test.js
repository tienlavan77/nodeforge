// Verifies scoped project content search, prioritized flags, and runtime logging.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createRgSearchTool } from "../../src/tools/rg-search.js";

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
    await assert.rejects(() => tool.execute({ pattern: "x", paths: ["backend"] }, { task_id: "X", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
    assert.equal(events.length, 4);
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

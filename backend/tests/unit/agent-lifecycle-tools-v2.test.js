import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool, createCommitChangesTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-tools-v2-"));
  const fileService = createFileService({ projectRoot: root });
  return { root, fileService };
}

test("read_file returns a bounded line window with whole-file checksum", async () => {
  const { fileService } = await harness();
  await writeFile(join(fileService.projectRoot ?? process.cwd(), "x"), "", () => {});
  const tool = createReadFileTool({ fileService });
  const big = Array.from({ length: 30 }, (_, i) => `line-${i + 1}`).join("\n");
  await fileService.atomicWrite({ path: "big.txt", content: big, replace: true });
  const full = await tool.execute({ path: "big.txt" }, {});
  assert.equal(full.total_lines, undefined);
  const window = await tool.execute({ path: "big.txt", offset: 28, limit: 500 }, {});
  assert.equal(window.content, "line-28\nline-29\nline-30");
  assert.equal(window.total_lines, 30);
  assert.equal(window.truncated, false);
  assert.equal(window.sha256, full.sha256, "checksum must be the whole-file hash");
  await assert.rejects(() => tool.execute({ path: "big.txt", offset: 31 }, {}), /OFFSET_OUT_OF_RANGE|beyond the last line/);
  await assert.rejects(() => tool.execute({ path: "big.txt", offset: 1, limit: 501 }, {}), /limit must be an integer/);
});

test("read_file previews files over 500 lines with a symbol map and requires a window", async () => {
  const { fileService } = await harness();
  const symbolCalls = [];
  const tool = createReadFileTool({ fileService, symbolLookup: (path) => { symbolCalls.push(path); return [{ name: "Header", kind: "component", start_line: 410, end_line: 480 }]; } });
  const big = Array.from({ length: 600 }, (_, i) => `line-${i + 1}`).join("\n");
  await fileService.atomicWrite({ path: "large.txt", content: big, replace: true });
  const full = await tool.execute({ path: "large.txt" }, {});
  assert.equal(full.total_lines, 600);
  assert.equal(full.truncated, true);
  assert.equal(full.content, Array.from({ length: 40 }, (_, i) => `line-${i + 1}`).join("\n"));
  assert.match(full.notice, /offset\/limit/);
  assert.deepEqual(full.symbol_map, [{ name: "Header", kind: "component", start_line: 410, end_line: 480 }]);
  assert.deepEqual(symbolCalls, ["large.txt"]);
  assert.equal(full.sha256, `sha256:${createHash("sha256").update(big).digest("hex")}`);
  const window = await tool.execute({ path: "large.txt", offset: 590, limit: 500 }, {});
  assert.equal(window.content, "line-590\nline-591\nline-592\nline-593\nline-594\nline-595\nline-596\nline-597\nline-598\nline-599\nline-600");
  assert.equal(window.truncated, false);
  assert.equal("symbol_map" in window, false);
});

test("repeated windowed reads hit EXPLORATION_STAGNANT and a successful edit resets the streak", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await fileService.atomicWrite({ path: "code.js", content: "const a = 1;\nconst b = 2;\n", replace: true });
  const context = { task_id: "T-STAG" };
  const input = { path: "code.js", offset: 1, limit: 500 };
  await read.execute(input, context);
  await read.execute(input, context);
  await read.execute(input, context);
  await assert.rejects(() => read.execute(input, context), (error) => error.code === "EXPLORATION_STAGNANT");
  const before = await read.execute({ path: "code.js" }, context);
  await edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "const b = 2;", replacement: "const b = 3;" }, context);
  const input2 = { path: "code.js", offset: 1, limit: 500 };
  await read.execute(input2, context);
  await read.execute(input2, context);
  await assert.rejects(() => read.execute(input2, context), (error) => error.code === "EXPLORATION_STAGNANT");
});

test("write_diff rejects content over 8 KB with CONTENT_TOO_LARGE", async () => {
  const { fileService } = await harness();
  const tool = createWriteDiffTool({ fileService });
  const big = "x".repeat(8193);
  await assert.rejects(() => tool.execute({ path: "big.txt", content: big, before_checksum: null }, {}), (error) => {
    assert.equal(error.code, "CONTENT_TOO_LARGE");
    assert.equal(error.details.byte_length, 8193);
    assert.equal(error.details.limit, 8192);
    return true;
  });
  await tool.execute({ path: "ok.txt", content: "x".repeat(8192), before_checksum: null }, {});
});

test("write_diff rejects replacing an existing file over 8 KB", async () => {
  const { fileService } = await harness();
  const tool = createWriteDiffTool({ fileService });
  const original = "x".repeat(8193);
  await fileService.atomicWrite({ path: "large.css", content: original, replace: true });
  const before = await createReadFileTool({ fileService }).execute({ path: "large.css" }, {});
  await assert.rejects(() => tool.execute({ path: "large.css", content: "small\n", before_checksum: before.sha256 }, {}), (error) => {
    assert.equal(error.code, "DESTRUCTIVE_OVERWRITE");
    assert.equal(error.details.current_bytes, 8193);
    return true;
  });
  assert.equal(await fileService.readFile({ path: "large.css" }), original);
});


test("edit_diff replaces a unique anchor, verifies checksum, and reports errors", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const write = createWriteDiffTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await write.execute({ path: "code.js", content: "const a = 1;\nconst b = 2;\n", before_checksum: null }, {});
  const before = await read.execute({ path: "code.js" }, {});
  const result = await edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "const b = 2;", replacement: "const b = 3;" }, {});
  assert.equal(result.replaced_count, 1);
  const after = await read.execute({ path: "code.js" }, {});
  assert.equal(after.content, "const a = 1;\nconst b = 3;\n");
  assert.notEqual(after.sha256, before.sha256);

  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: before.sha256, anchor: "x", replacement: "y" }, {}), (error) => error.code === "CHECKSUM_MISMATCH");
  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: after.sha256, anchor: "missing text", replacement: "y" }, {}), (error) => error.code === "ANCHOR_NOT_FOUND");
  await assert.rejects(() => edit.execute({ path: "code.js", before_checksum: after.sha256, anchor: "const", replacement: "let" }, {}), (error) => {
    assert.equal(error.code, "ANCHOR_NOT_UNIQUE");
    assert.equal(error.details.occurrences, 2);
    return true;
  });
  await assert.rejects(() => edit.execute({ path: "ghost.js", before_checksum: null, anchor: "x", replacement: "y" }, {}), (error) => error.code === "CHECKSUM_MISMATCH");
});

test("edit_diff with occurrence=all replaces every match and skips uniqueness check", async () => {
  const { fileService } = await harness();
  const read = createReadFileTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  await fileService.atomicWrite({ path: "multi.txt", content: "TODO\nkeep\nTODO\n", replace: true });
  const before = await read.execute({ path: "multi.txt" }, {});
  const result = await edit.execute({ path: "multi.txt", before_checksum: before.sha256, anchor: "TODO", replacement: "DONE", occurrence: "all" }, {});
  assert.equal(result.replaced_count, 2);
  const after = await read.execute({ path: "multi.txt" }, {});
  assert.equal(after.content, "DONE\nkeep\nDONE\n");
});

test("write_diff and edit_diff record changed paths and commit_changes uses them", async () => {
  const { fileService } = await harness();
  const context = { task_id: "T-CHANGE", changed_paths: [] };
  const read = createReadFileTool({ fileService });
  const write = createWriteDiffTool({ fileService });
  const edit = createEditDiffTool({ fileService });
  const committed = [];
  const commit = createCommitChangesTool({ gitService: { commit: async (message, { paths }) => { committed.push({ message, paths }); return { sha: "SHA-1" }; } } });

  await write.execute({ path: "new-file.txt", content: "hello\n", before_checksum: null }, context);
  await fileService.atomicWrite({ path: "multi.txt", content: "TODO\n", replace: true });
  await edit.execute({ path: "multi.txt", before_checksum: (await read.execute({ path: "multi.txt" }, {})).sha256, anchor: "TODO", replacement: "DONE" }, context);

  await commit.execute({ message: "feat: apply agent changes" }, context);
  assert.deepEqual(committed[0].paths, ["new-file.txt", "multi.txt"]);
  assert.equal(committed[0].message, "feat: apply agent changes");
});

test("commit_changes without any applied change reports SCOPE_INVALID", async () => {
  const context = { task_id: "T-EMPTY", changed_paths: [] };
  const commit = createCommitChangesTool({ gitService: { commit: async () => { throw new Error("must not be called"); } } });
  await assert.rejects(() => commit.execute({ message: "empty" }, context), (error) => error.code === "SCOPE_INVALID");
});

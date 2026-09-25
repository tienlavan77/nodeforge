// Verifies scoped sed line reads, symbol map reuse, and project log failures.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";

const context = { task_id: "SED-1", capabilities: ["sed_lines"], correlation_id: "C-SED" };

// Captures the same structured runtime events persisted by the Control API.
function captureLogger(events) {
  return createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write() {} } });
}

// Compares a bounded file window with GNU sed and returns read_file's symbol hints.
test("sed_lines reads exact source lines and reuses symbol lookup", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sed-lines-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "example.js"), "one\ntwo\nthree\nfour\n");
    const events = [];
    const symbols = [{ name: "example", start_line: 2, end_line: 3 }];
    const tool = createSedLinesTool({ projectRoot: root, symbolLookup: (path) => path === "backend/example.js" ? symbols : [], logger: captureLogger(events) });
    const actual = await tool.execute({ path: "backend/example.js", start_line: 1, end_line: 3 }, context);
    const expected = spawnSync("sed", ["-n", "1,3p", "--", "backend/example.js"], { cwd: root, encoding: "utf8" });
    assert.deepEqual({ stdout: actual.stdout, stderr: actual.stderr, exit_code: actual.exit_code, signal: actual.signal }, { stdout: expected.stdout, stderr: expected.stderr, exit_code: expected.status, signal: expected.signal });
    assert.deepEqual(actual.symbol_map, symbols);
    assert.equal(actual.symbol_map_verified, false);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.sed_lines_started", "forge.sed_lines_completed"]);
    assert.deepEqual(events[1].payload.command, ["sed", "-n", "1,3p", "--", "backend/example.js"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Supplies the whole-file checksum needed by Codex edit_diff without exposing read_file.
test("sed_lines returns a scoped whole-file checksum for Codex edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sed-checksum-"));
  try {
    await mkdir(join(root, "backend"));
    await writeFile(join(root, "backend", "example.js"), "one\ntwo\n");
    const tool = createSedLinesTool({ projectRoot: root, fileService: createFileService({ projectRoot: root }), logger: captureLogger([]) });
    const scoped = { ...context, allowed_file_paths: ["backend/example.js"] };
    const result = await tool.execute({ path: "backend/example.js", start_line: 1, end_line: 1 }, scoped);
    assert.equal(result.stdout, "one\n");
    assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.total_lines, 3);
    await assert.rejects(() => tool.execute({ path: "backend/example.js", start_line: 1, end_line: 1 }, context), /Node-approved file scope/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Rejects out-of-scope reads before sed can see hidden, ignored, or linked files.
test("sed_lines rejects unsafe paths, line windows, and agent authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sed-scope-"));
  const outside = await mkdtemp(join(tmpdir(), "nodeforge-sed-outside-"));
  try {
    await mkdir(join(root, ".git"));
    await mkdir(join(root, "backend"));
    await writeFile(join(root, ".gitignore"), "backend/ignored.js\n");
    await writeFile(join(root, "backend", "ignored.js"), "SECRET\n");
    await writeFile(join(root, "backend", "safe.js"), "SAFE\n");
    await writeFile(join(outside, "outside.js"), "OUTSIDE\n");
    await symlink(join(outside, "outside.js"), join(root, "backend", "linked.js"));
    const events = [];
    const tool = createSedLinesTool({ projectRoot: root, logger: captureLogger(events) });
    for (const path of ["../outside.js", "backend/ignored.js", "backend/linked.js", ".git/config"]) {
      await assert.rejects(() => tool.execute({ path, start_line: 1, end_line: 1 }, context));
    }
    await assert.rejects(() => tool.execute({ path: "backend/safe.js", start_line: 1, end_line: 501 }, context), /at most 500 lines/);
    await assert.rejects(() => tool.execute({ path: "backend/safe.js", start_line: 1, end_line: 1 }, { task_id: "SED-1", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
    assert.ok(events.every((event) => event.event_name === "forge.sed_lines_rejected" && event.status === "failed"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

// Logs an optional symbol lookup failure while still returning the verified source lines.
test("sed_lines logs symbol lookup errors without losing the sed result", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sed-symbol-"));
  try {
    await writeFile(join(root, "example.js"), "one\n");
    const events = [];
    const tool = createSedLinesTool({ projectRoot: root, symbolLookup: () => { throw new Error("index unavailable"); }, logger: captureLogger(events) });
    const result = await tool.execute({ path: "example.js", start_line: 1, end_line: 1 }, context);
    assert.equal(result.stdout, "one\n");
    assert.equal(events.at(-1).event_name, "forge.sed_lines_symbol_lookup_failed");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Stops oversized source lines and records the bounded-output failure.
test("sed_lines rejects output above its byte budget", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-sed-large-"));
  try {
    await writeFile(join(root, "large.js"), `${"x".repeat(210000)}\n`);
    const events = [];
    const tool = createSedLinesTool({ projectRoot: root, logger: captureLogger(events) });
    await assert.rejects(() => tool.execute({ path: "large.js", start_line: 1, end_line: 1 }, context), (error) => error.code === "SED_LINES_OUTPUT_TOO_LARGE");
    assert.equal(events.at(-1).event_name, "forge.sed_lines_failed");
    assert.equal(events.at(-1).error_code, "SED_LINES_OUTPUT_TOO_LARGE");
  } finally { await rm(root, { recursive: true, force: true }); }
});

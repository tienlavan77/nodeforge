// Verifies Node-owned file discovery returns ripgrep's real output under agent authorization.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rgPath } from "@vscode/ripgrep";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createRgFilesTool } from "../../src/tools/rg-files.js";

const context = { task_id: "T-1", capabilities: ["rg_files"], correlation_id: "C-1" };

// Captures events through the same runtime logger used by the Control API.
function captureLogger(events) {
  return createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write() {} } });
}

// Compares file listing and process status against the exact ripgrep command in one project root.
test("rg_files executes exactly rg --files with native ignores and output", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-rg-files-"));
  try {
    await mkdir(join(projectRoot, "src"));
    await mkdir(join(projectRoot, ".git"));
    await writeFile(join(projectRoot, ".gitignore"), "ignored.txt\n");
    await writeFile(join(projectRoot, "src", "kept.js"), "export const kept = true;\n");
    await writeFile(join(projectRoot, "ignored.txt"), "ignored\n");
    await writeFile(join(projectRoot, ".hidden"), "hidden\n");
    const events = [];
    const tool = createRgFilesTool({ projectRoot, logger: captureLogger(events) });
    const expected = spawnSync(rgPath, ["--files"], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(expected.error, undefined);
    const actual = await tool.execute({}, context);
    assert.deepEqual(actual, { stdout: expected.stdout, stderr: expected.stderr, exit_code: expected.status, signal: expected.signal });
    assert.match(actual.stdout, /src\/kept\.js/);
    assert.doesNotMatch(actual.stdout, /ignored\.txt|\.hidden/);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.rg_files_started", "forge.rg_files_completed"]);
    assert.equal(events[1].task_id, context.task_id);
    assert.deepEqual(events[1].payload.command, ["rg", "--files"]);
    assert.equal(events[1].payload.cwd, projectRoot);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// Compares approved filtering flags against the same native ripgrep invocation.
test("rg_files preserves approved flags and their order", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-rg-flags-"));
  try {
    await writeFile(join(projectRoot, ".hidden.js"), "hidden\n");
    await writeFile(join(projectRoot, "visible.js"), "visible\n");
    await writeFile(join(projectRoot, "visible.txt"), "text\n");
    const flags = ["--glob=!*.txt", "--max-depth=1", "--sort=path"];
    const events = [];
    const tool = createRgFilesTool({ projectRoot, logger: captureLogger(events) });
    const expected = spawnSync(rgPath, ["--files", ...flags], { cwd: projectRoot, encoding: "utf8" });
    const actual = await tool.execute({ flags }, context);
    assert.deepEqual(actual, { stdout: expected.stdout, stderr: expected.stderr, exit_code: expected.status, signal: expected.signal });
    assert.deepEqual(events[1].payload.command, ["rg", "--files", ...flags]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

// Rejects unapproved use, path operands, and flags that change the command purpose.
test("rg_files requires task capability and approved flags", async () => {
  const events = [];
  const tool = createRgFilesTool({ projectRoot: tmpdir(), logger: captureLogger(events) });
  await assert.rejects(() => tool.execute({}, { task_id: "T-1", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
  await assert.rejects(() => tool.execute({}, { capabilities: ["rg_files"] }), (error) => error.code === "TOOL_SCOPE_INVALID");
  await assert.rejects(() => tool.execute({ hidden: true }, context), /only a flags array/);
  for (const flags of [["../outside"], ["--pre=sh"], ["--files-with-matches"], ["--glob", "*.js"], ["--hidden"], ["--no-ignore"], ["--glob=*.js"], ["--iglob=.hidden.js"]]) {
    await assert.rejects(() => tool.execute({ flags }, context), /unsupported flag/);
  }
  assert.equal(events.length, 11);
  assert.ok(events.every((event) => event.event_name === "forge.rg_files_rejected" && event.status === "failed"));
  assert.equal(events[1].task_id, "RG-FILES-UNSCOPED");
  assert.equal(events[1].error_code, "TOOL_SCOPE_INVALID");
  assert.equal(events[2].error_code, "RG_FILES_INPUT_INVALID");
});

// Prevents inherited ripgrep configuration from expanding the listing into ignored directories.
test("rg_files keeps hidden and ignored directories out of agent results", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-rg-scope-"));
  const outsideRoot = await mkdtemp(join(tmpdir(), "nodeforge-rg-outside-"));
  try {
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, "ignored"));
    await writeFile(join(projectRoot, ".gitignore"), "ignored/\n");
    await writeFile(join(projectRoot, ".git", "config"), "hidden\n");
    await writeFile(join(projectRoot, "ignored", "secret.js"), "ignored\n");
    await writeFile(join(projectRoot, "visible.js"), "visible\n");
    await writeFile(join(outsideRoot, "outside.js"), "outside\n");
    await symlink(outsideRoot, join(projectRoot, "external-link"));
    const configPath = join(projectRoot, "ripgrep.conf");
    await writeFile(configPath, "--hidden\n--no-ignore\n");
    const events = [];
    const tool = createRgFilesTool({ projectRoot, logger: captureLogger(events), environment: { ...process.env, RIPGREP_CONFIG_PATH: configPath } });
    const result = await tool.execute({}, context);
    assert.match(result.stdout, /visible\.js/);
    assert.doesNotMatch(result.stdout, /\.git\/config|ignored\/secret\.js|\.gitignore|external-link|outside\.js/);
    assert.equal(events[1].event_name, "forge.rg_files_completed");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(outsideRoot, { recursive: true, force: true });
  }
});

// Records both ripgrep failures and process spawn failures without hiding their original result.
test("rg_files logs process errors through the runtime logger", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "nodeforge-rg-error-"));
  try {
    const events = [];
    const tool = createRgFilesTool({ projectRoot, logger: captureLogger(events) });
    const result = await tool.execute({ flags: ["--type=unknown_file_type"] }, context);
    assert.equal(result.exit_code, 2);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.rg_files_started", "forge.rg_files_failed"]);
    assert.equal(events[1].error_code, "RG_FILES_EXIT_NONZERO");
    assert.ok(events[1].payload.stderr_bytes > 0);
    await rm(projectRoot, { recursive: true, force: true });
    await assert.rejects(() => tool.execute({}, context), (error) => error.code === "ENOENT");
    assert.equal(events.at(-1).event_name, "forge.rg_files_failed");
    assert.equal(events.at(-1).error_code, "ENOENT");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

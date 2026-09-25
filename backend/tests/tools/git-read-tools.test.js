// Verifies agent Git inspection reuses the project Git Service and logs failures.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createGitReadTools } from "../../src/tools/git-read-tools.js";
import { createForgeToolRegistry, gitDiffDefinition, gitStatusDefinition } from "../../src/tools/index.js";

const context = { task_id: "GIT-READ-1", capabilities: ["git_status", "git_diff"], correlation_id: "C-GIT" };

// Captures the runtime log entries that the Control API would persist.
function captureLogger(events) {
  return createRuntimeLogger({ logEvent: (event) => events.push(event), output: { write() {} } });
}

// Compares status and diff output with the native Git commands in an isolated repository.
test("git_status and git_diff return real Git Service results", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-git-read-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "example.js"), "one\n");
    execFileSync("git", ["add", "example.js"], { cwd: root });
    execFileSync("git", ["-c", "user.name=NodeForge Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial"], { cwd: root });
    await writeFile(join(root, "example.js"), "one\ntwo\n");
    const events = [];
    const tools = createGitReadTools({ gitService: createGitService({ projectRoot: root }), logger: captureLogger(events) });
    const status = await tools.git_status.execute({}, context);
    const diff = await tools.git_diff.execute({}, context);
    assert.equal(status.stdout, execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }));
    assert.deepEqual({ working_tree: status.working_tree, changed_files: status.changed_files, staged_files: status.staged_files, unstaged_files: status.unstaged_files, untracked_files: status.untracked_files }, { working_tree: "dirty", changed_files: 1, staged_files: 0, unstaged_files: 1, untracked_files: 0 });
    assert.equal(diff.stdout, execFileSync("git", ["diff", "--"], { cwd: root, encoding: "utf8" }));
    assert.equal(diff.has_changes, true);
    assert.deepEqual(events.map((event) => event.event_name), ["forge.git_status_started", "forge.git_status_completed", "forge.git_diff_started", "forge.git_diff_completed"]);
    assert.equal(events[3].payload.stdout_bytes, Buffer.byteLength(diff.stdout));
    assert.equal(events[1].payload.working_tree, "dirty");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Rejects unapproved agent requests and propagates Git Service errors with audit events.
test("Git read tools log authorization, input, and repository failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-git-read-failure-"));
  try {
    const events = [];
    const tools = createGitReadTools({ gitService: createGitService({ projectRoot: root }), logger: captureLogger(events) });
    await assert.rejects(() => tools.git_status.execute({}, { task_id: "GIT-READ-1", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
    await assert.rejects(() => tools.git_diff.execute({ staged: true }, context), (error) => error.code === "GIT_READ_INPUT_INVALID");
    await assert.rejects(() => tools.git_status.execute({}, context), (error) => error.code === "GIT_STATUS_FAILED");
    await assert.rejects(() => tools.git_diff.execute({}, context), (error) => error.code === "GIT_DIFF_FAILED");
    assert.deepEqual(events.map((event) => event.event_name), ["forge.git_status_rejected", "forge.git_diff_rejected", "forge.git_status_started", "forge.git_status_failed", "forge.git_diff_started", "forge.git_diff_failed"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Confirms the agent registry advertises both Git reads and logs their task status.
test("Forge agent registry dispatches Git reads with task authorization", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-git-registry-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    await writeFile(join(root, "example.js"), "one\n");
    const events = [];
    const registry = createForgeToolRegistry({ protocolStorage: { get: async () => null }, fileService: { readForIndex: async () => null }, gitService: createGitService({ projectRoot: root }), projectLogger: (event) => events.push(event) });
    assert.equal(gitStatusDefinition.name, "git_status");
    assert.equal(gitDiffDefinition.name, "git_diff");
    assert.match((await registry.git_status.execute({}, context)).stdout, /example\.js/);
    await registry.git_diff.execute({}, context);
    await assert.rejects(() => registry.git_status.execute({}, { task_id: "GIT-READ-1", capabilities: [] }), (error) => error.code === "TOOL_FORBIDDEN");
    assert.ok(events.some((event) => event.event_name === "forge.git_status_completed" && event.status === "success"));
    assert.ok(events.some((event) => event.event_name === "forge.tool_failed" && event.payload.tool === "git_status"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

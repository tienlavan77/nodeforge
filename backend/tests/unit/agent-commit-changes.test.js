// Verifies that Forge commits only approved agent changes and records commit outcomes.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGitService } from "../../src/infrastructure/git/git-service.js";
import { createCommitChangesTool } from "../../src/tools/agent-verification-tools.js";

const run = promisify(execFile);

// Creates an isolated Git repository for commit scope checks without touching the project worktree.
async function repo() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-agent-commit-"));
  const git = async (...args) => (await run("git", args, { cwd: root })).stdout.trim();
  await git("init", "-q");
  await git("config", "user.name", "Forge Test");
  await git("config", "user.email", "forge-test@example.invalid");
  await writeFile(join(root, "task.txt"), "before\n");
  await writeFile(join(root, "other.txt"), "before\n");
  await git("add", "--", "task.txt", "other.txt");
  await git("commit", "-qm", "initial");
  return { root, git };
}

test("commit_changes commits only the task path and leaves unrelated staged work intact", async (t) => {
  const { root, git } = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "task.txt"), "task update\n");
  await writeFile(join(root, "other.txt"), "unrelated update\n");
  await git("add", "--", "other.txt");
  const events = [];
  const tool = createCommitChangesTool({ gitService: createGitService({ projectRoot: root }), logger: { emit: (event) => events.push(event) } });
  const result = await tool.execute({ message: "save task" }, { task_id: "T-COMMIT", capabilities: ["commit_changes"], changed_paths: ["task.txt"], allowed_file_paths: ["task.txt"] });
  assert.match(result.sha, /^[a-f0-9]{40,64}$/);
  assert.equal(await git("show", "--pretty=format:", "--name-only", "HEAD"), "task.txt");
  assert.equal(await git("diff", "--cached", "--name-only"), "other.txt");
  assert.equal(await readFile(join(root, "other.txt"), "utf8"), "unrelated update\n");
  assert.deepEqual(events.map((event) => event.event_name), ["forge.commit_changes_started", "forge.commit_changes_completed"]);
  assert.equal(events[1].task_id, "T-COMMIT");
  assert.equal(events[1].payload.sha, result.sha);
  assert.equal(JSON.stringify(events).includes("save task"), false);
});

test("commit_changes includes a new approved file without committing staged neighbors", async (t) => {
  const { root, git } = await repo();
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "new[1].txt"), "new task file\n");
  await writeFile(join(root, "other.txt"), "unrelated update\n");
  await git("add", "--", "other.txt");
  const tool = createCommitChangesTool({ gitService: createGitService({ projectRoot: root }), logger: { emit: () => {} } });
  await tool.execute({ message: "add task file" }, { task_id: "T-NEW", capabilities: ["commit_changes"], changed_paths: ["new[1].txt"], allowed_file_paths: ["new[1].txt"] });
  assert.equal(await git("show", "--pretty=format:", "--name-only", "HEAD"), "new[1].txt");
  assert.equal(await git("diff", "--cached", "--name-only"), "other.txt");
});

test("commit_changes rejects unapproved paths and records the rejection", async () => {
  const events = [];
  const tool = createCommitChangesTool({ gitService: { commit: async () => { throw new Error("must not commit"); } }, logger: { emit: (event) => events.push(event) } });
  const context = { task_id: "T-SCOPE", capabilities: ["commit_changes"], changed_paths: ["other.txt"], allowed_file_paths: ["task.txt"] };
  await assert.rejects(() => tool.execute({ message: "save" }, context), (error) => error.code === "SCOPE_INVALID");
  assert.equal(events[0].event_name, "forge.commit_changes_rejected");
  assert.equal(events[0].error_code, "SCOPE_INVALID");
  await assert.rejects(() => tool.execute({ message: "save" }, { task_id: "T-SCOPE", capabilities: ["commit_changes"], changed_paths: ["task.txt"] }), (error) => error.code === "SCOPE_INVALID");
  await assert.rejects(() => tool.execute({ message: "save" }, { task_id: "T-SCOPE", changed_paths: ["task.txt"], allowed_file_paths: ["task.txt"] }), (error) => error.code === "TOOL_FORBIDDEN");
});

test("commit_changes reports Git failures and preserves the underlying error", async () => {
  const events = [];
  const cause = Object.assign(new Error("Git failed"), { code: "GIT_COMMIT_FAILED" });
  const tool = createCommitChangesTool({ gitService: { commit: async () => { throw cause; } }, logger: { emit: (event) => events.push(event) } });
  const context = { task_id: "T-FAIL", capabilities: ["commit_changes"], changed_paths: ["task.txt"], allowed_file_paths: ["task.txt"] };
  await assert.rejects(() => tool.execute({ message: "save" }, context), (error) => error === cause);
  assert.deepEqual(events.map((event) => event.event_name), ["forge.commit_changes_started", "forge.commit_changes_failed"]);
  assert.equal(events[1].error_code, "GIT_COMMIT_FAILED");
});

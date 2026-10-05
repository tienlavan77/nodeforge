import test from "node:test";
import assert from "node:assert/strict";
import { createGitService } from "../../src/infrastructure/git/git-service.js";

function fakeGit() {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); if (args[0] === "show-ref") return { stdout: "", exitCode: 1 }; if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, exitCode: 0 }; if (args[0] === "branch" && args[1] === "--show-current") return { stdout: "main\n", exitCode: 0 }; if (args[0] === "diff") return { stdout: "src/example.js\n", exitCode: 0 }; return { stdout: "ok\n", exitCode: 0 }; } };
}

test("Git Service validates configuration and branch names", () => {
  assert.throws(() => createGitService(), /project root/);
  const git = createGitService({ projectRoot: "/repo", runGit: fakeGit().run });
  assert.rejects(git.createBranch("../escape"), (error) => error.code === "GIT_INVALID_BRANCH");
});

test("Git Service creates a branch through argument-array executor", async () => {
  const fake = fakeGit();
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  const result = await git.createBranch("task/TICKET-1");
  assert.deepEqual(result, { name: "task/TICKET-1", base_commit: "a".repeat(40) });
  assert.deepEqual(fake.calls.at(-1), ["switch", "-c", "task/TICKET-1"]);
});

test("Git Service refuses protected/current branch discard", async () => {
  const git = createGitService({ projectRoot: "/repo", runGit: fakeGit().run });
  await assert.rejects(() => git.discardBranch("main"), (error) => error.code === "GIT_PROTECTED_BRANCH");
  await assert.rejects(() => git.discardBranch("task/../bad"), (error) => error.code === "GIT_INVALID_BRANCH");
});

test("Git Service commits only explicitly staged paths and returns SHA", async () => {
  const fake = fakeGit();
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  const result = await git.commit("feat: add example", { paths: ["src/example.js"] });
  assert.equal(result.sha, "a".repeat(40));
  assert.deepEqual(fake.calls.find((args) => args[0] === "add"), ["add", "--", ":(literal)src/example.js"]);
  assert.deepEqual(fake.calls.find((args) => args[0] === "commit"), ["commit", "--only", "-m", "feat: add example", "--", ":(literal)src/example.js"]);
});

test("Git Service pushes only the exact current commit to origin on an unprotected branch", async () => {
  const fake = fakeGit();
  fake.run = async (args) => {
    fake.calls.push(args);
    if (args[0] === "branch") return { stdout: "ui-chat\n", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: `${"a".repeat(40)}\n`, exitCode: 0 };
    return { stdout: "pushed\n", exitCode: 0 };
  };
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  assert.deepEqual(await git.pushCommit("a".repeat(40)), { sha: "a".repeat(40), remote: "origin", branch: "ui-chat", output: "pushed\n" });
  assert.deepEqual(fake.calls.at(-1), ["push", "--porcelain", "origin", "HEAD:refs/heads/ui-chat"]);
  await assert.rejects(() => git.pushCommit("b".repeat(40)), (error) => error.code === "GIT_PUSH_HEAD_MISMATCH");
  fake.run = async (args) => args[0] === "branch" ? { stdout: "main\n", exitCode: 0 } : { stdout: `${"a".repeat(40)}\n`, exitCode: 0 };
  const protectedGit = createGitService({ projectRoot: "/repo", runGit: fake.run });
  await assert.rejects(() => protectedGit.pushCommit("a".repeat(40)), (error) => error.code === "GIT_PROTECTED_BRANCH");
});

test("Git Service holds the project mutation lock across staging and commit", async () => {
  const calls = [];
  const fake = fakeGit();
  const git = createGitService({ projectRoot: "/repo", runGit: async (args) => { calls.push(`git:${args[0]}`); return fake.run(args); }, mutationLock: async (action) => { calls.push("lock"); try { return await action(); } finally { calls.push("unlock"); } } });
  await git.commit("ticket", { paths: ["src/example.js"] });
  assert.deepEqual(calls, ["lock", "git:add", "git:diff", "git:commit", "git:rev-parse", "unlock"]);
  calls.length = 0;
  await git.getHead();
  assert.deepEqual(calls, ["git:rev-parse"]);
});

test("Git Service rejects empty commits and unsafe paths", async () => {
  const fake = fakeGit();
  fake.run = async (args) => args[0] === "diff" ? { stdout: "", exitCode: 0 } : fakeGit().run(args);
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  await assert.rejects(() => git.commit("empty", { paths: ["src/example.js"] }), (error) => error.code === "GIT_EMPTY_COMMIT");
  await assert.rejects(() => git.commit("bad", { paths: ["../outside.js"] }), /safe relative paths/);
});

test("Git Service merges an existing branch and rejects missing/self merges", async () => {
  const fake = fakeGit();
  fake.run = async (args) => {
    fake.calls.push(args);
    if (args[0] === "show-ref") return { stdout: "abc\n", exitCode: 0 };
    if (args[0] === "branch" && args[1] === "--show-current") return { stdout: "main\n", exitCode: 0 };
    return { stdout: "ok\n", exitCode: 0 };
  };
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  const result = await git.merge("task/TICKET-1");
  assert.equal(result.target, "main");
  assert.deepEqual(fake.calls.at(-1), ["merge", "--no-ff", "--no-edit", "task/TICKET-1"]);
  await assert.rejects(() => git.merge("task/TICKET-1", { target: "task/TICKET-1" }), (error) => error.code === "GIT_MERGE_SELF");
});

test("Git Service exposes safe branch/revision and merge recovery primitives", async () => {
  const fake = fakeGit();
  fake.run = async (args) => {
    fake.calls.push(args);
    if (args[0] === "show-ref") return { stdout: "abc\n", exitCode: 0 };
    if (args[0] === "branch" && args[1] === "--show-current") return { stdout: "main\n", exitCode: 0 };
    if (args[0] === "status") return { stdout: "UU src/conflicted.js\n M src/clean.js\n", exitCode: 0 };
    if (args[0] === "diff") return { stdout: "M\tsrc/example.js\n", exitCode: 0 };
    if (args[0] === "rev-parse") return { stdout: "abc123\n", exitCode: 0 };
    return { stdout: "ok\n", exitCode: 0 };
  };
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  assert.equal(await git.getHead(), "abc123");
  assert.equal(await git.getBranchHead("task/TICKET-1"), "abc123");
  assert.deepEqual(await git.hasConflicts(), { has_conflicts: true, paths: ["src/conflicted.js"] });
  assert.match(await git.diffBetween("abc123", "def456"), /src\/example\.js/);
  await git.abortMerge();
  await git.resetTo("abc123", { hard: true });
  assert.deepEqual(fake.calls.at(-1), ["reset", "--hard", "abc123"]);
  await assert.rejects(() => git.resetTo("../escape", { hard: true }), (error) => error.code === "GIT_INVALID_REVISION");
});

test("Git Service reads a path-scoped patch across committed and working-tree edits", async () => {
  const fake = fakeGit();
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  assert.match(await git.diffPatchFrom("abc123", { paths: ["src/example.js"] }), /src\/example.js/);
  assert.deepEqual(fake.calls.at(-1), ["diff", "--no-ext-diff", "--unified=3", "abc123", "--", "src/example.js"]);
  await assert.rejects(() => git.diffPatchFrom("../unsafe", { paths: ["src/example.js"] }), (error) => error.code === "GIT_INVALID_REVISION");
});

test("Git Service emits structured audit events without affecting operations", async () => {
  const fake = fakeGit();
  const events = [];
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run, onEvent: (event) => events.push(event) });
  await git.status({ paths: ["src/example.js"] });
  await git.commit("feat: example", { paths: ["src/example.js"] });
  assert.deepEqual(events.map(({ type }) => type), ["git.status", "git.add", "git.commit"]);
  assert.deepEqual(events[1].paths, ["src/example.js"]);
  assert.equal(typeof events[2].timestamp, "string");
});

test("Git Service reads the unstaged patch and rejects Git command failures", async () => {
  const fake = fakeGit();
  const git = createGitService({ projectRoot: "/repo", runGit: fake.run });
  assert.equal(await git.diffWorkingTree(), "src/example.js\n");
  assert.deepEqual(fake.calls.at(-1), ["diff", "--"]);
  const failed = createGitService({ projectRoot: "/repo", runGit: async () => ({ stdout: "", stderr: "not a repository", exitCode: 128 }) });
  await assert.rejects(() => failed.status(), (error) => error.code === "GIT_STATUS_FAILED");
  await assert.rejects(() => failed.diffWorkingTree(), (error) => error.code === "GIT_DIFF_FAILED");
});

test("Git Service refuses discard of a missing branch", async () => {
  const git = createGitService({ projectRoot: "/repo", runGit: fakeGit().run });
  await assert.rejects(() => git.discardBranch("task/MISSING"), (error) => error.code === "GIT_BRANCH_NOT_FOUND");
});

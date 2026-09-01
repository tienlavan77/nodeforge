import test from "node:test";
import assert from "node:assert/strict";
import { createGitService } from "../../src/infrastructure/git/git-service.js";

function fakeGit() {
  const calls = [];
  return { calls, run: async (args) => { calls.push(args); if (args[0] === "show-ref") return { stdout: "", exitCode: 1 }; if (args[0] === "rev-parse") return { stdout: "abc123\n", exitCode: 0 }; if (args[0] === "branch" && args[1] === "--show-current") return { stdout: "main\n", exitCode: 0 }; if (args[0] === "diff") return { stdout: "src/example.js\n", exitCode: 0 }; return { stdout: "ok\n", exitCode: 0 }; } };
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
  assert.deepEqual(result, { name: "task/TICKET-1", base_commit: "abc123" });
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
  assert.equal(result.sha, "abc123");
  assert.deepEqual(fake.calls.find((args) => args[0] === "add"), ["add", "--", "src/example.js"]);
  assert.deepEqual(fake.calls.find((args) => args[0] === "commit"), ["commit", "-m", "feat: add example"]);
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
  assert.deepEqual(fake.calls.at(-1), ["merge", "--no-edit", "task/TICKET-1"]);
  await assert.rejects(() => git.merge("task/TICKET-1", { target: "task/TICKET-1" }), (error) => error.code === "GIT_MERGE_SELF");
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

test("Git Service refuses discard of a missing branch", async () => {
  const git = createGitService({ projectRoot: "/repo", runGit: fakeGit().run });
  await assert.rejects(() => git.discardBranch("task/MISSING"), (error) => error.code === "GIT_BRANCH_NOT_FOUND");
});

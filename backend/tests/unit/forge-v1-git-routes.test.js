// Verify owner-confirmed Git commit and push routes use the validated workspace service.
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { createForgeV1Router } from "../../src/transport/http/forge-v1-router.js";

// Routes all changed files through Git Service and pushes the exact created commit.
test("commit-push commits every changed path and pushes its exact SHA", async () => {
  const calls = [];
  const router = createForgeV1Router({ expectedProjectId: "PROJECT-1", gitService: {
    status: async ({ nulTerminated }) => { assert.equal(nulTerminated, true); return " M tracked.js\0?? new file.js\0R  renamed.js\0old.js\0"; },
    commit: async (message, options) => { calls.push({ message, options }); return { sha: "a".repeat(40) }; },
    pushCommit: async (sha) => { calls.push({ sha }); return { sha, remote: "origin", branch: "feature" }; },
    statusSummary: async () => ({ state: "dirty" })
  } });
  const result = await router.route("POST", new URL("http://localhost/forge/v1/git/commit-push?project=PROJECT-1"), Readable.from([JSON.stringify({ project_id: "PROJECT-1", message: "Save workspace" })]));
  assert.equal(result.status, 200);
  assert.equal(result.body.status, "pushed");
  assert.equal(result.body.changed_files, 3);
  assert.deepEqual(calls, [
    { message: "Save workspace", options: { paths: ["tracked.js", "new file.js", "renamed.js"] } },
    { sha: "a".repeat(40) }
  ]);
});

// Restricts the owner Git action to the configured project.
test("commit-push rejects another project without running Git mutations", async () => {
  const router = createForgeV1Router({ expectedProjectId: "PROJECT-1", gitService: { status: async () => assert.fail("Git status must not run") } });
  await assert.rejects(() => router.route("POST", new URL("http://localhost/forge/v1/git/commit-push?project=PROJECT-2"), Readable.from([JSON.stringify({ message: "Save" })])), { code: "PROJECT_NOT_FOUND" });
});

// Reports a failed push separately after preserving the successful local commit.
test("commit-push reports when the commit succeeds but push fails", async () => {
  const router = createForgeV1Router({ expectedProjectId: "PROJECT-1", gitService: {
    status: async () => " M file.js\0",
    commit: async () => ({ sha: "b".repeat(40) }),
    pushCommit: async () => { throw new Error("remote unavailable"); }
  } });
  const result = await router.route("POST", new URL("http://localhost/forge/v1/git/commit-push?project=PROJECT-1"), Readable.from([JSON.stringify({ message: "Save" })]));
  assert.equal(result.body.status, "push_failed");
  assert.equal(result.body.commit_sha, "b".repeat(40));
});

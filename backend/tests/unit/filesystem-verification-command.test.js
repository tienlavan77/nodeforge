// Verifies real-denial tests reach the isolated runner without changing unrelated
// checks or losing an externally provisioned manifest in the verification child.
import assert from "node:assert/strict";
import test from "node:test";
import { filesystemVerificationCommand, FILESYSTEM_ENVIRONMENT_TEST } from "../../src/modules/supervisor/filesystem-verification-command.js";
import { ticketVerificationRunnerRevision } from "../../src/modules/supervisor/ticket/ticket-verification-runner-revision.js";

test("filesystem acceptance uses the container with the exact Node arguments and archive cwd", () => {
  const argv = [process.execPath, "--test", "--test-reporter=tap", FILESYSTEM_ENVIRONMENT_TEST];
  const cwd = "/project/.forge/runtime/tickets/ticket-verification/archives/nodeforge-ticket-archive-fixture";
  const result = filesystemVerificationCommand(argv, cwd, {});
  assert.equal(result[0], process.execPath);
  assert(result[1].endsWith("/backend/scripts/verify-filesystem-environment.mjs"));
  assert.deepEqual(result.slice(2), ["--cwd", cwd, "--", ...argv]);
});

test("external manifests and unrelated checks preserve native execution", () => {
  const argv = [process.execPath, "--test", FILESYSTEM_ENVIRONMENT_TEST];
  assert.equal(filesystemVerificationCommand(argv, "/project", { NODEFORGE_FILESYSTEM_FIXTURES: "/project/manifest.json" }), argv);
  const ordinary = [process.execPath, "--test", "backend/tests/unit/file-service.test.js"];
  assert.equal(filesystemVerificationCommand(ordinary, "/project", {}), ordinary);
});

test("filesystem runner repairs change retry identity without changing the ticket", async () => {
  const plan = [{ kind: "test", test_path: FILESYSTEM_ENVIRONMENT_TEST }];
  const paths = [];
  const original = await ticketVerificationRunnerRevision(plan, { readSource: async url => { paths.push(url.pathname); return "original"; } });
  const fixturePaths = paths.filter(path => /filesystem-verification-command|verify-filesystem-environment|test-environments\/filesystem/.test(path));
  const namespacePaths = paths.filter(path => /verify-filesystem-namespace/.test(path));
  assert.equal(fixturePaths.length + namespacePaths.length, 11);
  for (const fixturePath of [...fixturePaths, ...namespacePaths]) {
    assert.notEqual(await ticketVerificationRunnerRevision(plan, {
      readSource: async url => url.pathname === fixturePath ? "repaired" : "original"
    }), original);
  }
});

// Keeps the archive and argument vector intact when the verifier has been
// configured to reuse retained namespace fixtures rather than start a container.
test("retained namespace receives the exact verification command", () => {
  const argv = [process.execPath, "--test", "--test-reporter=tap", FILESYSTEM_ENVIRONMENT_TEST];
  const cwd = "/project/archive";
  const environment = { NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET: "/project/.forge/scratch/fs-ns-test/runner.sock" };
  const result = filesystemVerificationCommand(argv, cwd, environment);
  assert(result[1].endsWith("/backend/scripts/verify-filesystem-namespace.mjs"));
  assert.deepEqual(result.slice(2), ["run", "--cwd", cwd, "--", ...argv]);
  assert.equal(filesystemVerificationCommand(argv, cwd, { ...environment, NODEFORGE_FILESYSTEM_FIXTURES: "/live/manifest.json" }), argv);
});

// A new retained session replaces lost mounts and must unlock a bounded retry
// without altering the ticket; unrelated verification identities stay stable.
test("namespace session replacement changes only filesystem retry identity", async () => {
  const previous = process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET;
  const plan = [{ kind: "test", test_path: FILESYSTEM_ENVIRONMENT_TEST }];
  const options = { readSource: async () => "same source" };
  try {
    process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET = "/project/fs-ns-first/runner.sock";
    const original = await ticketVerificationRunnerRevision(plan, options);
    const ordinary = await ticketVerificationRunnerRevision([], options);
    process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET = "/project/fs-ns-second/runner.sock";
    assert.notEqual(await ticketVerificationRunnerRevision(plan, options), original);
    assert.equal(await ticketVerificationRunnerRevision([], options), ordinary);
  } finally {
    if (previous === undefined) delete process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET;
    else process.env.NODEFORGE_FILESYSTEM_NAMESPACE_SOCKET = previous;
  }
});

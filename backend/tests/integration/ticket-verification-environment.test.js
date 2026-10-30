// Exercises real checks against committed ticket files plus separately recorded dirty project dependencies.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket/ticket-root-git.js";
import { captureVerificationEnvironment, loadVerificationEnvironment, readVerificationEnvironmentFile, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { materializeTicketVerification } from "../../src/modules/supervisor/ticket/ticket-verification-materialization.js";

const execute = promisify(execFile);

// Creates an isolated project with a committed ticket importer and deliberately uncommitted dependencies.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nf-environment-"));
  const git = createTicketRootGit({ projectRoot: root });
  await git.run(["init"]); await git.run(["config", "user.name", "Fixture"]); await git.run(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, ".gitignore"), ".forge/\n.env\nnode_modules/\n");
  await writeFile(join(root, "ticket.mjs"), 'import { value } from "./dependency.mjs"; if (value !== 42) throw new Error("wrong dependency");\n');
  await writeFile(join(root, "removed.txt"), "old dependency\n");
  await mkdir(join(root, "old-directory")); await writeFile(join(root, "old-directory/entry.txt"), "old\n");
  await writeFile(join(root, "deleted-ticket.txt"), "delete this\n");
  await git.run(["add", "."]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  await rm(join(root, "deleted-ticket.txt")); await git.run(["add", "deleted-ticket.txt"]);
  await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "ticket deletion"]);
  const commitSha = (await git.run(["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "dependency.mjs"), "export const value = 42;\n");
  await writeFile(join(root, "ticket.mjs"), 'throw new Error("must never use live ticket bytes");\n');
  await writeFile(join(root, "deleted-ticket.txt"), "must stay deleted in verification\n");
  await rm(join(root, "removed.txt"));
  await rm(join(root, "old-directory"), { recursive: true });
  await writeFile(join(root, "old-directory"), "directory became a regular file\n");
  await writeFile(join(root, ".env"), "SECRET=excluded\n");
  await symlink("/etc/passwd", join(root, "outside-link"));
  const ticketPaths = ["ticket.mjs", "deleted-ticket.txt"];
  const environment = await captureVerificationEnvironment({ projectRoot: root, ticketPaths });
  return { root, git, commitSha, environment, ticketPaths, close: () => rm(root, { recursive: true, force: true }) };
}

test("real Node execution uses committed ticket bytes with untracked dependencies and workspace deletions", async () => {
  const f = await fixture(); let archive;
  try {
    const bindings = await Promise.all(Array.from({ length: 8 }, () => persistVerificationEnvironment(f.root, f.environment)));
    assert(bindings.every((binding) => binding.sha256 === f.environment.sha256));
    assert((await readdir(join(f.root, ".forge/runtime/ticket-verification/environment/blobs"))).every((name) => !name.endsWith(".tmp")));
    const index = await readFile(join(f.root, ".git/index"));
    archive = await materializeTicketVerification({ projectRoot: f.root, ...f });
    const result = await execute(process.execPath, ["ticket.mjs"], { cwd: archive.path });
    assert.equal(result.stderr, "");
    for (const path of ["removed.txt", "deleted-ticket.txt", ".env", "outside-link"]) await assert.rejects(readFile(join(archive.path, path)), { code: "ENOENT" });
    assert.equal(await readFile(join(archive.path, "old-directory"), "utf8"), "directory became a regular file\n");
    await archive.assertEnvironment();
    assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
    assert.equal((await f.git.run(["rev-parse", "HEAD"])).trim(), f.commitSha);
    const manifest = await loadVerificationEnvironment(f.root, archive.environment);
    const dependency = manifest.find((entry) => entry.path === "dependency.mjs");
    await writeFile(join(f.root, "dependency.mjs"), "changed after snapshot\n");
    assert.equal((await readVerificationEnvironmentFile(f.root, dependency)).toString(), "export const value = 42;\n");
    await writeFile(join(archive.path, "dependency.mjs"), "test modified input\n");
    await assert.rejects(archive.assertEnvironment(), { code: "VERIFY_ENVIRONMENT_CHANGED" });
    await writeFile(join(f.root, ".forge/runtime/ticket-verification/environment/blobs", dependency.sha256), "corrupt\n");
    await assert.rejects(readVerificationEnvironmentFile(f.root, dependency), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await writeFile(join(f.root, archive.environment.manifest_path), "[]");
    await assert.rejects(loadVerificationEnvironment(f.root, archive.environment), { code: "VERIFY_ENVIRONMENT_INVALID" });
  } finally {
    await archive?.cleanup();
    assert.deepEqual(await readdir(join(f.root, ".forge/runtime/ticket-verification/archives")), []);
    await f.close();
  }
});

// Rejects structural collisions before a project snapshot can replace an immutable ticket path.
test("environment cannot overwrite a committed ticket subtree or resurrect a deleted ticket as a directory", async () => {
  const f = await fixture();
  try {
    await assert.rejects(captureVerificationEnvironment({ projectRoot: f.root, ticketPaths: ["dependency.mjs/owned.js"] }), { code: "VERIFY_ENVIRONMENT_INVALID" });
    await assert.rejects(captureVerificationEnvironment({ projectRoot: f.root, ticketPaths: ["old-directory/owned.js"] }), { code: "VERIFY_ENVIRONMENT_INVALID" });
  } finally { await f.close(); }
});

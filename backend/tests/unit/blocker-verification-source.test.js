// Checks exact committed dependency evidence without copying dirty files into immutable verification archives.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";
import { inspectVerificationSource } from "../../src/modules/supervisor/blocker-verification-source.js";

// Creates the source-composition fault where an importer is committed but its module is workspace-only.
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-verification-source-"));
  const git = createTicketRootGit({ projectRoot });
  await git.run(["init"]); await git.run(["config", "user.email", "fixture@example.invalid"]); await git.run(["config", "user.name", "Fixture"]);
  await mkdir(join(projectRoot, "backend")); await writeFile(join(projectRoot, "backend/main.js"), 'import "./dependency.js";\n');
  await git.run(["add", "backend/main.js"]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture"]);
  const context = { review_commit_sha: (await git.run(["rev-parse", "HEAD"])).trim() };
  await writeFile(join(projectRoot, "backend/dependency.js"), "export const dependency = true;\n");
  const diagnostic = { commands: [{ exit_code: 1, stdout_redacted: `Error: Cannot find module '${projectRoot}/.forge/runtime/ticket-verification/archives/nodeforge-ticket-archive-ABC/backend/dependency.js' imported from main.js` }] };
  return { projectRoot, context, diagnostic, git, close: () => rm(projectRoot, { recursive: true, force: true }) };
}

test("missing committed dependency is proven separately from workspace existence and hash", async () => {
  const f = await fixture();
  try {
    const before = await f.git.run(["status", "--porcelain"]);
    const result = await inspectVerificationSource(f);
    assert.equal(result.files.length, 1); assert.equal(result.files[0].committed, false);
    assert.equal(result.files[0].workspace_present, true); assert.match(result.files[0].workspace_sha256, /^sha256:/);
    assert.equal(result.commit_sha, f.context.review_commit_sha);
    assert.equal(await f.git.run(["status", "--porcelain"]), before);
    assert.match(result.interpretation, /not a dependency commit/);
  } finally { await f.close(); }
});

test("committed missing-module paths stay distinguishable from absent Git tree entries", async () => {
  const f = await fixture();
  try {
    await f.git.run(["add", "backend/dependency.js"]); await f.git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "fixture dependency"]);
    f.context.review_commit_sha = (await f.git.run(["rev-parse", "HEAD"])).trim();
    assert.equal((await inspectVerificationSource(f)).files[0].committed, true);
  } finally { await f.close(); }
});

test("traversal and outside-archive text cannot produce arbitrary file probes", async () => {
  const f = await fixture();
  try {
    f.diagnostic.commands[0].stdout_redacted = "Cannot find module '/etc/passwd'";
    assert.deepEqual((await inspectVerificationSource(f)).files, []);
    f.diagnostic.commands[0].stdout_redacted = `Cannot find module '${f.projectRoot}/.forge/runtime/ticket-verification/archives/nodeforge-ticket-archive-X/backend/../../outside'`;
    await assert.rejects(inspectVerificationSource(f), { code: "TICKET_PATH_CONFLICT" });
  } finally { await f.close(); }
});

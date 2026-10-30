// Verifies finding repairs coexist with other writers while preserving passed source and per-file ownership.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFile as callback } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRootWorkspace } from "../../src/modules/supervisor/ticket/ticket-root-workspace.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket/ticket-execution-context.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";

const execFile = promisify(callback);
// Runs one source-history operation in the isolated witness repository.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }
// Hashes immutable source and verification command evidence.
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Creates a settled verified journal with two previously edited files.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-finding-repair-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.name", "NodeForge Test");
  await git(root, "config", "user.email", "nodeforge-test@localhost");
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  for (const path of ["source.js", "unrelated.js"]) await writeFile(join(root, path), "const value = 1;\n");
  await git(root, "add", ".gitignore", "source.js", "unrelated.js");
  await git(root, "commit", "-qm", "baseline");
  const files = createFileService({ projectRoot: root });
  const service = createTicketRootWorkspace({ projectRoot: root, projectId: "PROJECT-1", stateFileService: files,
    protocolStorage: { save: async () => {}, get: async () => ({ data: {} }) }, indexDatabase: { all: () => [] },
    codeSearch: { search: async () => [] }, fileGraph: { getDependencies: () => [], getDependents: () => [] } });
  const workspace = await service.open("TICKET-1");
  const input = { workspace, taskId: "TICKET-1", supervisorId: "SUP-1" };
  await prepareTicketExecutionContext(input);
  for (const path of ["source.js", "unrelated.js"]) await workspace.changeLedger.write({ path, before: "const value = 1;\n", after: "const value = 2;\n" });
  let context = await workspace.executionContexts.syncManifest("TICKET-1", await workspace.changeLedger.snapshot());
  const commit = await workspace.gitService.commit("first repair");
  context = await workspace.executionContexts.update("TICKET-1", context.version, { state: "committed", review_commit_sha: commit.sha });
  const command = { kind: "typecheck", argv: ["node", "check"] };
  const artifact = { artifact_id: "ARTIFACT-FINDING", status: "passed", commit_sha: commit.sha, source_revision: context.source_revision,
    manifest_sha: context.manifest_sha, base_sha: context.base_sha, tree_sha: await git(root, "rev-parse", `${commit.sha}^{tree}`),
    changed_paths: ["source.js", "unrelated.js"], file_checksums: { "source.js": hash("const value = 2;\n"), "unrelated.js": hash("const value = 2;\n") },
    policy_version: "ticket-verification-v8", environment: await persistVerificationEnvironment(root, await captureVerificationEnvironment({ projectRoot: root, ticketPaths: ["source.js", "unrelated.js"] })),
    planned_commands: [command], commands: [{ ...command, exit_code: 0, output_sha256: hash("") }] };
  await files.atomicWrite({ path: ".forge/runtime/ticket-verification/TICKET-1/artifacts/ARTIFACT-FINDING.json", content: JSON.stringify(artifact), replace: false });
  context = await workspace.executionContexts.update("TICKET-1", context.version, { state: "reviewing", verification_artifact_id: artifact.artifact_id });
  return { root, files, service, workspace, input, artifact, context, reviewKey: `sha256:${"c".repeat(64)}` };
}

test("finding repair ignores historical file drift and foreign claims, commits only new writes, and retains its prior evidence", async () => {
  const f = await fixture();
  try {
    const archivedIdentity = structuredClone(f.context);
    await f.workspace.changeLedger.release({ close: false });
    const foreign = await f.service.open("TICKET-2");
    await prepareTicketExecutionContext({ workspace: foreign, taskId: "TICKET-2", supervisorId: "SUP-2" });
    await foreign.changeLedger.write({ path: "unrelated.js", before: "const value = 2;\n", after: "const value = 99;\n" });
    const repair = await f.workspace.beginFindingRepair(f.reviewKey);
    assert.deepEqual(await f.workspace.beginFindingRepair(f.reviewKey), repair);
    const fresh = await f.workspace.executionContexts.load("TICKET-1");
    assert.equal(fresh.state, "coding");
    assert.equal(fresh.verification_artifact_id, null);
    assert.deepEqual(fresh.manifest_paths, []);
    await prepareTicketExecutionContext(f.input);
    await f.workspace.changeLedger.resume();
    const receipt = JSON.parse(await f.files.readFile({ path: repair.receipt }));
    assert.deepEqual(receipt.context, archivedIdentity);
    assert.deepEqual(receipt.artifact, f.artifact);
    const history = await f.workspace.loadReviewRepairSource(fresh);
    assert.equal(history.length, 1);
    assert.deepEqual(Object.keys(history[0].entries).sort(), ["source.js", "unrelated.js"]);
    await assert.rejects(f.workspace.changeLedger.write({ path: "unrelated.js", before: "const value = 99;\n", after: "const value = 100;\n" }), { code: "FILE_CLAIM_CONFLICT" });
    await f.workspace.changeLedger.write({ path: "source.js", before: "const value = 2;\n", after: "const value = 3;\n" });
    const manifest = await f.workspace.changeLedger.snapshot();
    assert.deepEqual(Object.keys(manifest.entries), ["source.js"]);
    assert.deepEqual(await f.workspace.beginFindingRepair(f.reviewKey), repair);
    assert.deepEqual(await f.workspace.changeLedger.snapshot(), manifest);
    const commit = await f.workspace.gitService.commit("finding repair only");
    assert.equal(await git(f.root, "diff-tree", "--no-commit-id", "--name-only", "-r", commit.sha), "source.js");
    assert.equal(await git(f.root, "show", `${commit.sha}:unrelated.js`), "const value = 2;");
    assert.equal(await readFile(join(f.root, "unrelated.js"), "utf8"), "const value = 99;\n");
    const before = await f.workspace.executionContexts.load("TICKET-1");
    await assert.rejects(f.workspace.beginFindingRepair(`sha256:${"d".repeat(64)}`), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });
    assert.deepEqual(await f.workspace.executionContexts.load("TICKET-1"), before);
    await assert.rejects(f.workspace.changeLedger.write({ path: "source.js", before: "const value = 2;\n", after: "stale overwrite" }), { code: "CHECKSUM_MISMATCH" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test("finding repair recovers a crash between journal rotation and context rotation", async () => {
  const f = await fixture();
  try {
    const first = await f.workspace.beginFindingRepair(f.reviewKey);
    const scope = createHash("sha256").update("PROJECT-1").digest("hex");
    const contextPath = `.forge/runtime/ticket-execution-contexts/${scope}/TICKET-1.json`;
    await f.files.atomicWrite({ path: contextPath, content: JSON.stringify(f.context), replace: true });
    assert.deepEqual(await f.workspace.beginFindingRepair(f.reviewKey), first);
    const ready = await f.workspace.executionContexts.load("TICKET-1");
    assert.equal(ready.state, "coding");
    assert.equal(ready.source_repair_cycle_id, f.reviewKey.slice(7));
    await f.files.atomicWrite({ path: first.receipt, content: JSON.stringify({ ...JSON.parse(await f.files.readFile({ path: first.receipt })), project_id: "FOREIGN" }), replace: true });
    await assert.rejects(f.workspace.loadReviewRepairSource(ready), { code: "REVIEW_REPAIR_SOURCE_CONFLICT" });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

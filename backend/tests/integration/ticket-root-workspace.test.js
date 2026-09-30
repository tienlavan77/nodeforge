// Checks that new root-only tickets open Forge services without creating Git worktrees.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { execFile as callback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketWorkspaceService } from "../../src/modules/supervisor/ticket-workspace-service.js";
import { prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";

const execFile = promisify(callback);

// Runs one Git command inside the disposable witness repository.
async function git(root, ...args) { return (await execFile("git", ["-C", root, ...args])).stdout.trim(); }

test("root-only workspace uses the project source and leaves historical worktrees untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-workspace-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "source.js"), "const value = 1;\n");
    await git(root, "add", ".gitignore", "source.js");
    await git(root, "commit", "-qm", "baseline");
    const fileService = createFileService({ projectRoot: root });
    const service = createTicketWorkspaceService({ projectRoot: root, projectId: "P-ROOT-WORKSPACE", protocolStorage: { save: async () => {}, get: async () => ({ data: {} }) }, stateFileService: fileService, indexDatabase: { all: () => [] }, codeSearch: { search: async () => [] }, fileGraph: { getDependencies: () => [], getDependents: () => [] }, rootOnly: true });
    const prepared = await service.ensure("TICKET-ROOT");
    assert.equal(prepared.path, root);
    assert.equal(prepared.root_only, true);
    const workspace = await service.open("TICKET-ROOT");
    await prepareTicketExecutionContext({ workspace, taskId: "TICKET-ROOT", supervisorId: "SUP-ROOT" });
    await workspace.changeLedger.write({ path: "source.js", before: "const value = 1;\n", after: "const value = 2;\n" });
    const context = await workspace.executionContexts.syncManifest("TICKET-ROOT", await workspace.changeLedger.snapshot());
    const result = await workspace.gitService.commit("root ticket");
    const committed = await workspace.executionContexts.update("TICKET-ROOT", context.version, { state: "committed", review_commit_sha: result.sha });
    const command = { kind: "typecheck", argv: ["node", "check"] };
    const artifact = { artifact_id: "ARTIFACT-ROOT", status: "passed", commit_sha: result.sha, source_revision: committed.source_revision,
      manifest_sha: committed.manifest_sha, base_sha: committed.base_sha, tree_sha: await git(root, "rev-parse", `${result.sha}^{tree}`),
      policy_version: "ticket-verification-v3", planned_commands: [command], commands: [{ ...command, exit_code: 0, output_sha256: `sha256:${createHash("sha256").update("").digest("hex")}` }] };
    await fileService.atomicWrite({ path: ".forge/runtime/ticket-verification/TICKET-ROOT/artifacts/ARTIFACT-ROOT.json", content: JSON.stringify(artifact), replace: false });
    await workspace.executionContexts.update("TICKET-ROOT", committed.version, { state: "verified", verification_artifact_id: artifact.artifact_id });
    const competingIntegrations = await Promise.all([workspace.integrate(), workspace.integrate()]);
    assert.deepEqual(competingIntegrations.map(({ sha, repeated }) => ({ sha, repeated: repeated === true })).sort((a, b) => Number(a.repeated) - Number(b.repeated)),
      [{ sha: result.sha, repeated: false }, { sha: result.sha, repeated: true }]);
    const receiptPath = ".forge/runtime/ticket-integrations/TICKET-ROOT.json";
    const receipt = JSON.parse(await fileService.readFile({ path: receiptPath }));
    assert.equal(receipt.status, "completed");
    assert.equal(receipt.workspace_mode, "root-only");
    assert.equal(receipt.reviewed_commit, result.sha);
    assert.equal(receipt.commit, result.sha);
    assert.equal(receipt.branch, await git(root, "branch", "--show-current"));
    assert.equal(receipt.previous_head, result.sha);
    assert.match(receipt.recorded_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(await workspace.integrate(), { sha: result.sha, repeated: true });
    assert.deepEqual(JSON.parse(await fileService.readFile({ path: receiptPath })), receipt);
    await fileService.atomicWrite({ path: receiptPath, content: JSON.stringify({ ...receipt, status: "prepared" }), replace: true });
    assert.deepEqual(await workspace.integrate(), { sha: result.sha, recovered: true });
    assert.equal(JSON.parse(await fileService.readFile({ path: receiptPath })).status, "completed");
    await fileService.atomicWrite({ path: receiptPath, content: JSON.stringify({ ...receipt, status: "prepared", reviewed_commit: prepared.base_commit }), replace: true });
    await assert.rejects(workspace.integrate(), { code: "TICKET_INTEGRATION_CONFLICT" });
    assert.equal((await readFile(join(root, "source.js"), "utf8")), "const value = 2;\n");
    assert.equal(await git(root, "worktree", "list", "--porcelain").then((text) => text.split("\n").filter((line) => line.startsWith("worktree ")).length), 1);
    assert.equal(await workspace.worktreeFileService.readFile({ path: "source.js" }), "const value = 2;\n");
    await service.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("root-only preparation refuses an old Coder checkpoint without migrating it", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-legacy-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await git(root, "add", ".gitignore");
    await git(root, "commit", "-qm", "baseline");
    const fileService = createFileService({ projectRoot: root });
    await fileService.atomicWrite({ path: ".forge/runtime/agent-checkpoints/TICKET-OLD.json", content: JSON.stringify({ task_id: "TICKET-OLD", status: "in_progress" }), replace: false });
    const service = createTicketWorkspaceService({ projectRoot: root, projectId: "P-OLD", protocolStorage: { save: async () => {}, get: async () => ({ data: {} }) }, stateFileService: fileService, indexDatabase: { all: () => [] }, codeSearch: { search: async () => [] }, fileGraph: { getDependencies: () => [], getDependents: () => [] }, rootOnly: true });
    await assert.rejects(service.ensure("TICKET-OLD"), (error) => error.code === "TICKET_ROOT_CONTEXT_MIGRATION_REQUIRED");
    assert.equal(JSON.parse(await fileService.readFile({ path: ".forge/runtime/agent-checkpoints/TICKET-OLD.json" })).status, "in_progress");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// Keeps an out-of-scope Coder edit out of both the project source and ticket ledger.
test("root-only workspace checks the approved path before writing source", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-root-scope-"));
  try {
    await git(root, "init", "-q");
    await git(root, "config", "user.name", "NodeForge Test");
    await git(root, "config", "user.email", "nodeforge-test@localhost");
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "outside.js"), "const value = 1;\n");
    await git(root, "add", ".gitignore", "outside.js");
    await git(root, "commit", "-qm", "baseline");
    const fileService = createFileService({ projectRoot: root });
    const service = createTicketWorkspaceService({ projectRoot: root, projectId: "P-ROOT-SCOPE", protocolStorage: { save: async () => {}, get: async () => ({ data: {} }) }, stateFileService: fileService, indexDatabase: { all: () => [] }, codeSearch: { search: async () => [] }, fileGraph: { getDependencies: () => [], getDependents: () => [] }, rootOnly: true });
    const workspace = await service.open("TICKET-SCOPE");
    await workspace.executionContexts.create({ taskId: "TICKET-SCOPE", supervisorId: "SUP-SCOPE", baseSha: workspace.base_commit, baseline: { file_checksums: { "inside.js": "sha256:approved" } } });
    await assert.rejects(workspace.changeLedger.write({ path: "outside.js", before: "const value = 1;\n", after: "const value = 2;\n" }), { code: "TICKET_BASELINE_SCOPE" });
    assert.equal(await readFile(join(root, "outside.js"), "utf8"), "const value = 1;\n");
    assert.deepEqual((await workspace.changeLedger.snapshot()).entries, {});
    await service.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

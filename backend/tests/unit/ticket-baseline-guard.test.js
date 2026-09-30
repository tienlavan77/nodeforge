// Proves A5-R2 refuses changed Git or approval evidence before dispatching a Coder.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketExecutionContextStore, prepareTicketExecutionContext } from "../../src/modules/supervisor/ticket-execution-context.js";

const taskId = "NF-PIPE-ERR-005-A5-R2";
const sha = (value) => createHash("sha256").update(value).digest("hex");

// Creates a real clean checkout and a durable receipt for context and retry tests.
async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-a5-baseline-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  try {
    const fileService = createFileService({ projectRoot: root });
    await writeFile(join(root, ".gitignore"), ".forge/\n");
    await writeFile(join(root, "source.js"), "export const value = 1;\n");
    git("init", "-q", "-b", "ui-chat");
    git("add", ".gitignore", "source.js");
    git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    const contract = { supervisor: `SUP-${taskId}`, human_authority: "PROJECT-OWNER", gate: "shadow", ledger_revision: "revision-1", idempotency_key: "a5-r2", verification_plan: ["Verify"] };
    const checksums = { "source.js": sha("export const value = 1;\n") };
    const receipt = { status: "approved", ticket_id: taskId, project_id: "PROJECT-TEST", branch: "ui-chat", source_sha: git("rev-parse", "HEAD"), source_tree_sha: git("rev-parse", "HEAD^{tree}"), execution_root: root, file_checksums: checksums, manifest_sha256: sha(`source.js\t${checksums["source.js"]}\n`), contract, verification_plan: contract.verification_plan, migration_manifest_path: ".forge/runtime/migration.json", migration_manifest_sha256: sha("{}"), approved_by: "PROJECT-OWNER", approval_recorded_at: "2026-09-30T00:00:00Z" };
    await fileService.atomicWrite({ path: receipt.migration_manifest_path, content: "{}", replace: true });
    await fileService.atomicWrite({ path: `.forge/runtime/ticket-baselines/${taskId}.json`, content: JSON.stringify(receipt), replace: true });
    const open = () => createTicketExecutionContextStore({ fileService, projectId: "PROJECT-TEST", projectRoot: root });
    const workspace = (store = open()) => ({ root_only: true, projectRoot: root, fileService, branch: "ui-chat", base_commit: receipt.source_sha, executionContexts: store, changeLedger: { snapshot: async () => ({ revision: 0, entries: {}, commits: {} }) } });
    await action({ root, git, fileService, receipt, workspace, ticket: { id: taskId, project_id: "PROJECT-TEST", execution_contract: contract } });
  } finally { await rm(root, { recursive: true, force: true }); }
}

// Persists the signed identity unchanged across a simulated Control API restart.
test("A5-R2 baseline persists and resumes with an immutable file scope", () => fixture(async ({ receipt, workspace, ticket }) => {
  const first = await prepareTicketExecutionContext({ workspace: workspace(), taskId, supervisorId: receipt.contract.supervisor, ticket });
  assert.equal(first.approved_baseline.source_tree_sha, receipt.source_tree_sha);
  const resumed = await prepareTicketExecutionContext({ workspace: workspace(), taskId, supervisorId: receipt.contract.supervisor, ticket });
  assert.deepEqual(resumed, first);
  await assert.rejects(workspace().executionContexts.syncManifest(taskId, { revision: 1, entries: { "other.js": { initial_sha: null, latest_sha: "sha256:new" } } }), { code: "TICKET_BASELINE_SCOPE" });
}));

// Rejects a dirty checkout and altered contract without creating an execution context.
test("A5-R2 baseline fails closed on Git or ticket drift", () => fixture(async ({ root, receipt, workspace, ticket }) => {
  await writeFile(join(root, "untracked.txt"), "drift");
  await assert.rejects(prepareTicketExecutionContext({ workspace: workspace(), taskId, supervisorId: receipt.contract.supervisor, ticket }), { code: "TICKET_BASELINE_GIT" });
  await rm(join(root, "untracked.txt"));
  await assert.rejects(prepareTicketExecutionContext({ workspace: workspace(), taskId, supervisorId: receipt.contract.supervisor, ticket: { ...ticket, execution_contract: { ...ticket.execution_contract, gate: "enforce" } } }), { code: "TICKET_BASELINE_CONTRACT" });
  assert.equal(await workspace().executionContexts.load(taskId), null);
}));

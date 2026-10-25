/** Reproduces Node validating an AM response that cites a retained authority
 * receipt. Internal state reads must not use Reviewer source policy or expose
 * runtime reads to agents, foreign executions, or changed immutable bytes. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { assertRoleFileAccess } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { retainBlockerContract, readBlockerContracts } from "../../src/modules/supervisor/blocker-contract-evidence.js";
import { createBlockerContractFiles } from "../../src/modules/supervisor/blocker-contract-files.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

/** Persists and authenticates a real receipt, keeping the Node state reader
 * observable and deliberately rejecting all runtime reads in the source reader. */
async function fixture(t) {
  const projectRoot = await mkdtemp(join(tmpdir(), "nf-contract-files-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  const internal = createFileService({ projectRoot, role: "system_engineer" });
  const binding = { project_id: "P", task_id: "TASK", execution_id: "EXEC", sprint_basis: { version: 1 } };
  const job = { id: "J", stage: "architecture_manager", request: { ...binding, payload: binding, ticket: {} },
    history: [{ stage: "architecture_manager", completed_at: 1000, disposition: { action: "resolved", authority_scope: "architecture", guidance: "Preserve approved scope." } }] };
  const refs = await retainBlockerContract({ job, fileService: internal });
  const receipts = await readBlockerContracts({ receipts: refs, fileService: internal, binding });
  const reads = [];
  const stateFiles = { readFile: async (input) => { reads.push(input.path); return internal.readFile(input); } };
  const sourceFiles = { assertReadPath: async (path) => assertRoleFileAccess("reviewer", "read", path),
    readFile: async ({ path }) => { assertRoleFileAccess("reviewer", "read", path); return "source"; } };
  return { projectRoot, internal, binding, job, refs, receipts, reads, stateFiles, sourceFiles };
}

test("Node validates an issued AM authority receipt through state storage while source readers stay role-scoped", async (t) => {
  const f = await fixture(t), ref = f.refs[0];
  const value = { action: "reconciliation_required", summary: "Preserve the settled decision.", guidance: "Inspect the outstanding verification receipt.", evidence: [{ path: ref.path, sha256: ref.sha256 }] };
  const accepted = await validateBlockerDisposition(value, { job: f.job, fileService: f.sourceFiles, projectRoot: f.projectRoot,
    contractReceipts: f.receipts, contractFileService: f.stateFiles });
  assert.equal(accepted.action, "reconciliation_required"); assert.deepEqual(f.reads, [ref.path]);
  await assert.rejects(f.sourceFiles.readFile({ path: ref.path }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal((await f.internal.readFile({ path: ref.path })), await f.stateFiles.readFile({ path: ref.path }));
});

test("unissued and foreign receipts do not receive a Node read grant and return actionable correction", async (t) => {
  const f = await fixture(t), ref = f.refs[0];
  for (const receipts of [[], [{ ...f.receipts[0], record: { ...f.receipts[0].record, project_id: "OTHER" } }],
    [{ ...f.receipts[0], record: { ...f.receipts[0].record, execution_id: "OTHER" } }]]) {
    await assert.rejects(validateBlockerDisposition({ action: "reconciliation_required", summary: "Inspect receipt", guidance: "Preserve work",
      evidence: [{ path: ref.path, sha256: ref.sha256 }] }, { job: f.job, fileService: f.sourceFiles, projectRoot: f.projectRoot,
      contractReceipts: receipts, contractFileService: f.stateFiles }), (error) => error.code === "BLOCKER_DISPOSITION_INVALID"
        && error.validation_errors[0].reason === "contract_receipt_not_issued");
  }
  assert.deepEqual(f.reads, []);
});

test("an authenticated receipt never opens other runtime files and immutable bytes are rechecked on every read", async (t) => {
  const f = await fixture(t);
  const files = createBlockerContractFiles({ files: f.sourceFiles, stateFiles: f.stateFiles, receipts: f.receipts, job: f.job });
  await assert.rejects(files.assertReadPath(".forge/runtime/private.json"), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal(await files.readFile({ path: "src/file.js" }), "source");
  await f.internal.atomicWrite({ path: f.refs[0].path, content: "changed", replace: true });
  await assert.rejects(files.readFile({ path: f.refs[0].path }), { code: "BLOCKER_CONTRACT_EVIDENCE_INVALID" });
});

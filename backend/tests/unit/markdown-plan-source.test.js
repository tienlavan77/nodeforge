// Ensures approved plan execution uses original SUMMARY evidence without binding to a mutable working document.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createMarkdownPlanStore } from "../../src/modules/governance/markdown-plan-store.js";

// Creates a real indexed and owner-approved revision with a live project source file.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "markdown-source-"));
  const database = await createDatabaseService({ dataDir: join(root, ".forge/runtime"), runtimeDir: "." });
  const files = createFileService({ projectRoot: root });
  const store = createMarkdownPlanStore({ projectId: "PROJECT-A", database, fileService: files });
  const source = "# Original scope\nExact approved requirements.\n";
  const sourcePath = "workflows/summary.md";
  await files.atomicWrite({ path: sourcePath, content: source, replace: true });
  const plan = await store.createRevision({ planId: "PLAN-A", markdown: "# Approved scope", summaryPath: sourcePath,
    summarySha256: createHash("sha256").update(source).digest("hex") });
  await store.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "OWNER" });
  return { files, store, source, sourcePath, plan, snapshot: ".forge/runtime/nf/plans/PLAN-A/summary-r1.md",
    input: { planId: plan.plan_id, revision: 1, sha256: plan.sha256 },
    close: async () => { await database.close(); await rm(root, { recursive: true, force: true }); } };
}

test("editing or deleting the working SUMMARY preserves approval and the immutable source", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.files.readFile({ path: f.snapshot }), f.source);
    await f.files.atomicWrite({ path: f.sourcePath, content: "next draft", replace: true });
    assert.equal((await f.store.assertApproved(f.input)).source_sha256, f.plan.source_sha256);
    await f.files.deleteFile({ path: f.sourcePath });
    assert.equal((await f.store.assertApproved(f.input)).sha256, f.plan.sha256);
    await f.files.atomicWrite({ path: f.snapshot, content: "tampered", replace: true });
    await assert.rejects(() => f.store.assertApproved(f.input), { code: "PLAN_SOURCE_MISMATCH" });
  } finally { await f.close(); }
});

test("legacy source recovery accepts only original bytes and never changes the source or approval", async () => {
  const f = await fixture();
  try {
    await f.files.deleteFile({ path: f.snapshot });
    await f.store.assertApproved(f.input);
    assert.equal(await f.files.readFile({ path: f.snapshot }), f.source);
    await f.files.deleteFile({ path: f.snapshot });
    await f.files.atomicWrite({ path: f.sourcePath, content: "changed", replace: true });
    await assert.rejects(() => f.store.assertApproved(f.input), { code: "PLAN_SOURCE_MISMATCH" });
    await assert.rejects(() => f.store.restoreSourceSnapshot({ planId: "PLAN-A", revision: 1, summary: "changed" }), { code: "PLAN_SOURCE_MISMATCH" });
    await f.store.restoreSourceSnapshot({ planId: "PLAN-A", revision: 1, summary: f.source });
    await f.store.restoreSourceSnapshot({ planId: "PLAN-A", revision: 1, summary: f.source });
    const approved = await f.store.assertApproved(f.input);
    assert.equal(approved.sha256, f.plan.sha256);
    assert.equal(approved.decision.decision, "approved");
    assert.equal(await f.files.readFile({ path: f.sourcePath }), "changed");
    await f.files.atomicWrite({ path: f.snapshot, content: "corrupt", replace: true });
    await assert.rejects(() => f.store.restoreSourceSnapshot({ planId: "PLAN-A", revision: 1, summary: f.source }), { code: "PLAN_SOURCE_MISMATCH" });
  } finally { await f.close(); }
});

test("new plan revisions retain independent source snapshots and reject changed inputs before persistence", async () => {
  const f = await fixture();
  try {
    await f.files.atomicWrite({ path: f.sourcePath, content: "new source", replace: true });
    await assert.rejects(() => f.store.createRevision({ planId: "PLAN-A", expectedRevision: 1, markdown: "# Revised",
      summaryPath: f.sourcePath, summarySha256: f.plan.source_sha256 }), { code: "PLAN_SOURCE_MISMATCH" });
    const second = await f.store.createRevision({ planId: "PLAN-A", expectedRevision: 1, markdown: "# Revised",
      summaryPath: f.sourcePath, summarySha256: createHash("sha256").update("new source").digest("hex") });
    assert.equal(second.revision, 2);
    assert.equal(await f.files.readFile({ path: f.snapshot }), f.source);
    assert.equal(await f.files.readFile({ path: ".forge/runtime/nf/plans/PLAN-A/summary-r2.md" }), "new source");
    await assert.rejects(() => f.store.assertApproved({ ...f.input, revision: 2, sha256: second.sha256 }), { code: "PLAN_APPROVAL_REQUIRED" });
  } finally { await f.close(); }
});

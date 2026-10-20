// Verifies owner-cancelled legacy tickets cannot indefinitely reserve files needed by subsequent approved work.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { createTicketPipelineDisposition } from "../../src/modules/supervisor/ticket-pipeline-disposition.js";
import { createCancelledTicketClaimReconciliation } from "../../src/modules/supervisor/ticket-cancelled-claims.js";
import { inspectBlockerFileClaims } from "../../src/modules/supervisor/blocker-file-claims.js";
import { releaseInactiveTicketClaims } from "../../src/modules/supervisor/ticket-inactive-claims.js";

const projectId = "PROJECT-TEST";
const taskId = "TICKET-OLD";
const path = "backend/src/server.js";
const content = "// Existing accepted source must survive cancellation cleanup.\n";
const scope = `.forge/runtime/ticket-changes/${createHash("sha256").update(projectId).digest("hex")}`;
const journalPath = `${scope}/tickets/${createHash("sha256").update(taskId).digest("hex")}.json`;

// Creates a real claimed source and a durable owner-decision store entirely inside the project test sandbox.
async function fixture() {
  const base = resolve(".forge/test-tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "cancelled-claims-"));
  const fileService = createFileService({ projectRoot: root });
  const ledger = createTicketChangeLedger({ projectId, fileService });
  await ledger.write({ taskId, path, before: null, after: content });
  let active = false;
  const reconcileCancelledClaims = createCancelledTicketClaimReconciliation({ projectId, fileService, isExecutionActive: async () => active });
  const inventory = { inspect: async () => ({ tickets: [{ task_id: taskId, classification: "human-review-required", ledger: true }] }) };
  const disposition = createTicketPipelineDisposition({ projectId, fileService, inventory, reconcileCancelledClaims });
  const expectedFingerprint = (await disposition.inspect()).tickets[0].inventory_fingerprint;
  const decision = { taskId, disposition: "cancelled", actorId: "PROJECT-OWNER", actorRole: "human", evidenceRefs: ["existing-owner-decision"], expectedFingerprint };
  const claims = () => inspectBlockerFileClaims({ fileService, job: { request: { project_id: projectId }, evidence: [{ path }] } });
  return { fileService, ledger, disposition, reconcileCancelledClaims, decision, claims, setActive: (value) => { active = value; },
    close: () => rm(root, { recursive: true, force: true }) };
}

test("owner cancellation releases inactive file claims while preserving source and the complete change journal", async () => {
  const context = await fixture();
  try {
    assert.equal((await context.claims())[0].owner_task_id, taskId);
    await assert.rejects(context.ledger.write({ taskId: "TICKET-NEW", path, before: content, after: content }), { code: "FILE_CLAIM_CONFLICT" });
    const before = await context.ledger.load(taskId);
    const saved = await context.disposition.decide(context.decision);
    assert.equal(saved.disposition, "cancelled");
    assert.equal((await context.claims())[0].owner_task_id, null);
    assert.equal(await context.fileService.readFile({ path }), content);
    const after = await context.ledger.load(taskId);
    assert.equal(after.state, "closed");
    assert.deepEqual(after.entries, before.entries);
    assert.deepEqual(after.commits, before.commits);
    await context.ledger.write({ taskId: "TICKET-NEW", path, before: content, after: content });
    await context.disposition.get(taskId);
    assert.equal((await context.claims())[0].owner_task_id, "TICKET-NEW");
  } finally { await context.close(); }
});

test("a persisted cancellation defers cleanup during provider ownership and repairs it on a later read", async () => {
  const context = await fixture();
  try {
    context.setActive(true);
    const saved = await context.disposition.decide(context.decision);
    assert.equal((await context.claims())[0].owner_task_id, taskId);
    assert.equal((await context.reconcileCancelledClaims(saved)).reason, "active_execution");
    context.setActive(false);
    assert.equal((await context.disposition.get(taskId)).disposition, "cancelled");
    assert.equal((await context.claims())[0].owner_task_id, null);
  } finally { await context.close(); }
});

test("unauthenticated or cross-project cancellation records never release a source claim", async () => {
  const context = await fixture();
  try {
    const base = { disposition: "cancelled", project_id: projectId, task_id: taskId, actor_role: "human", actor_id: "OWNER", evidence_refs: ["decision"] };
    for (const change of [{ project_id: "OTHER" }, { actor_role: "coder" }, { evidence_refs: [] }, { task_id: "../unsafe" }]) {
      await assert.rejects(context.reconcileCancelledClaims({ ...base, ...change }));
      assert.equal((await context.claims())[0].owner_task_id, taskId);
    }
    assert.equal(await context.reconcileCancelledClaims({ ...base, disposition: "needs_human_review" }), null);
    assert.equal((await context.claims())[0].owner_task_id, taskId);
  } finally { await context.close(); }
});

test("cancellation cleanup defers incomplete writes or pending commits", async () => {
  const context = await fixture();
  try {
    const fileService = { ...context.fileService, readFile: async (input) => {
      const result = await context.fileService.readFile(input);
      if (input.path.includes("/tickets/")) return JSON.stringify({ ...JSON.parse(result), pending_commit: { revision: 1 } });
      return result;
    } };
    const reconcile = createCancelledTicketClaimReconciliation({ projectId, fileService, isExecutionActive: async () => false });
    const result = await reconcile({ disposition: "cancelled", project_id: projectId, task_id: taskId, actor_role: "human", actor_id: "OWNER", evidence_refs: ["decision"] });
    assert.equal(result.reason, "pending_mutation");
    assert.equal((await context.claims())[0].owner_task_id, taskId);
    assert.equal(await context.fileService.readFile({ path }), content);
  } finally { await context.close(); }
});

test("cleanup storage failures do not hide a durable owner cancellation as a missing decision", async () => {
  const context = await fixture();
  try {
    context.setActive(true);
    await context.disposition.decide(context.decision);
    const disposition = createTicketPipelineDisposition({ projectId, fileService: context.fileService,
      inventory: { inspect: async () => ({ tickets: [] }) },
      reconcileCancelledClaims: async () => { throw Object.assign(new Error("Journal unavailable"), { code: "ENOENT" }); } });
    await assert.rejects(disposition.get(taskId), { code: "ENOENT", message: "Journal unavailable" });
    assert.equal((await context.claims())[0].owner_task_id, taskId);
  } finally { await context.close(); }
});

test("persisted cancellation releases orphan claims even after its journal was already closed", async () => {
  const context = await fixture();
  try {
    context.setActive(true);
    await context.disposition.decide(context.decision);
    const manifest = { ...await context.ledger.load(taskId), state: "closed", entries: {} };
    await context.fileService.atomicWrite({ path: journalPath, content: JSON.stringify(manifest), replace: true });
    const claimPath = `${scope}/claims/${createHash("sha256").update(path).digest("hex")}.json`;
    await context.fileService.atomicWrite({ path: claimPath, content: JSON.stringify({ task_id: taskId, path }), replace: true });
    context.setActive(false);
    await context.disposition.get(taskId);
    assert.equal((await context.claims())[0].owner_task_id, null);
    assert.equal(await context.fileService.readFile({ path }), content);
    assert.deepEqual(await context.ledger.load(taskId), manifest);
    assert.equal((await context.reconcileCancelledClaims(await context.disposition.get(taskId))).status, "unchanged");
  } finally { await context.close(); }
});

test("owner-cancelled orphan claims can be released without inventing a missing journal", async () => {
  const context = await fixture();
  try {
    context.setActive(true);
    await context.disposition.decide(context.decision);
    await context.fileService.deleteFile({ path: journalPath });
    context.setActive(false);
    await context.disposition.get(taskId);
    assert.equal((await context.claims())[0].owner_task_id, null);
    await assert.rejects(context.fileService.readFile({ path: journalPath }), { code: "ENOENT" });
    assert.equal(await context.fileService.readFile({ path }), content);
  } finally { await context.close(); }
});

test("an explicit inactive release leaves review work resumable and preserves other tickets' claims", async () => {
  const context = await fixture();
  try {
    const before = await context.fileService.readFile({ path: journalPath });
    const release = { projectId, taskId, fileService: context.fileService, isExecutionActive: async () => false };
    assert.equal((await releaseInactiveTicketClaims(release)).status, "released");
    assert.equal(await context.fileService.readFile({ path: journalPath }), before);
    assert.equal(await context.fileService.readFile({ path }), content);
    await context.ledger.write({ taskId: "TICKET-NEW", path, before: content, after: content });
    assert.equal((await releaseInactiveTicketClaims(release)).status, "unchanged");
    assert.equal((await context.claims())[0].owner_task_id, "TICKET-NEW");
  } finally { await context.close(); }
});

test("a newly active execution fences release after claim discovery", async () => {
  const context = await fixture();
  try {
    let checks = 0;
    const result = await releaseInactiveTicketClaims({ projectId, taskId, fileService: context.fileService,
      isExecutionActive: async () => ++checks >= 3 });
    assert.equal(result.reason, "active_execution");
    assert.deepEqual(result.paths, []);
    assert.equal((await context.claims())[0].owner_task_id, taskId);
  } finally { await context.close(); }
});

test("inactive cleanup defers pending file writes and fails closed on invalid journal metadata", async () => {
  const context = await fixture();
  try {
    const manifest = await context.ledger.load(taskId);
    manifest.entries[path].pending = { operation_id: "INCOMPLETE-WRITE" };
    await context.fileService.atomicWrite({ path: journalPath, content: JSON.stringify(manifest), replace: true });
    const release = { projectId, taskId, fileService: context.fileService, isExecutionActive: async () => false };
    assert.equal((await releaseInactiveTicketClaims(release)).reason, "pending_mutation");
    assert.equal((await context.claims())[0].owner_task_id, taskId);
    for (const value of [null, { ...manifest, project_id: "OTHER-PROJECT" }]) {
      await context.fileService.atomicWrite({ path: journalPath, content: JSON.stringify(value), replace: true });
      await assert.rejects(releaseInactiveTicketClaims(release), /invalid identity/);
      assert.equal((await context.claims())[0].owner_task_id, taskId);
    }
    assert.equal(await context.fileService.readFile({ path }), content);
  } finally { await context.close(); }
});

test("claim ownership is rechecked under the path lock before an inactive release", async () => {
  const context = await fixture();
  try {
    let checks = 0;
    const claimPath = `${scope}/claims/${createHash("sha256").update(path).digest("hex")}.json`;
    const result = await releaseInactiveTicketClaims({ projectId, taskId, fileService: context.fileService,
      isExecutionActive: async () => {
        if (++checks === 3) await context.fileService.atomicWrite({ path: claimPath,
          content: JSON.stringify({ path, task_id: "TICKET-NEW", claim_id: "NEW-CLAIM" }), replace: true });
        return false;
      } });
    assert.equal(result.status, "unchanged");
    assert.equal((await context.claims())[0].owner_task_id, "TICKET-NEW");
  } finally { await context.close(); }
});

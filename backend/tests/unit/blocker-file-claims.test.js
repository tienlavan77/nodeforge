// Verifies blocker investigation receives current project-scoped ownership instead of replaying stale claim allegations.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { inspectBlockerFileClaims } from "../../src/modules/supervisor/blocker-file-claims.js";

test("SL and AM receive refreshed Node claim observations across an ownership reconciliation", async () => {
  const snapshots = [];
  const fixture = await blockerRecoveryFixture({ investigate: async (job, resolution) => {
    snapshots.push(job.authority_context.file_claims);
    return job.stage === "sprint_leader" ? { action: "architecture_required", summary: "AM must inspect the competing claim." } : resolution;
  } });
  try {
    const scope = createHash("sha256").update("P").digest("hex");
    const key = createHash("sha256").update(fixture.evidence.path).digest("hex");
    const path = `.forge/runtime/ticket-changes/${scope}/claims/${key}.json`;
    await fixture.base.fileService.atomicWrite({ path, content: JSON.stringify({ task_id: "OTHER-TICKET", path: fixture.evidence.path, claim_id: "CLAIM" }), replace: false });
    await assert.rejects(fixture.base.run(), { code: "CODER_BLOCKED" });
    await fixture.recovery.tick();
    assert.equal(snapshots[0].find((entry) => entry.path === fixture.evidence.path).owner_task_id, "OTHER-TICKET");
    await fixture.base.fileService.deleteFile({ path });
    await fixture.recovery.tick();
    assert.equal(snapshots[1].find((entry) => entry.path === fixture.evidence.path).owner_task_id, null);
  } finally { await fixture.close(); }
});

test("claim observations are project-scoped, deduplicated and bounded without reading arbitrary source", async () => {
  const reads = [];
  const job = { request: { project_id: "P" }, evidence: ["../outside:1", "/outside:1", ...Array.from({ length: 20 }, (_, index) => `backend/src/file-${index}.js:1`)],
    history: [{ disposition: { evidence: [{ path: "backend/src/file-19.js" }] } }] };
  const claims = await inspectBlockerFileClaims({ job, fileService: { readFile: async ({ path }) => {
    reads.push(path);
    throw Object.assign(new Error("Missing claim"), { code: "ENOENT" });
  } } });
  assert.equal(claims.length, 16);
  assert.equal(reads.length, 16);
  const scope = createHash("sha256").update("P").digest("hex");
  assert(reads.every((path) => path.startsWith(`.forge/runtime/ticket-changes/${scope}/claims/`)));
  assert(claims.every((entry) => entry.owner_task_id === null));
});

test("claim storage failures and malformed identities cannot masquerade as unclaimed files", async () => {
  const job = { request: { project_id: "P" }, evidence: [{ path: "backend/src/server.js" }] };
  await assert.rejects(inspectBlockerFileClaims({ job, fileService: { readFile: async () => { throw Object.assign(new Error("Storage failed"), { code: "EIO" }); } } }), { code: "EIO" });
  await assert.rejects(inspectBlockerFileClaims({ job, fileService: { readFile: async () => JSON.stringify({ path: "other.js", task_id: "OTHER", claim_id: "CLAIM" }) } }), /invalid identity/);
  for (const content of ["null", "false", "{}"]) {
    await assert.rejects(inspectBlockerFileClaims({ job, fileService: { readFile: async () => content } }), /invalid identity/);
  }
});

test("structured Coder source references expose the current server claim without historical disposition evidence", async () => {
  const path = "backend/src/transport/http/server.js";
  const reads = [];
  const job = { request: { project_id: "PROJECT-NODEFORGE" }, evidence: [{ type: "source", reference: `${path}:39`, result: "Dispatch mismatch" }] };
  const claims = await inspectBlockerFileClaims({ job, fileService: { readFile: async (input) => {
    reads.push(input.path);
    return JSON.stringify({ path, task_id: "TICKET-OLD", claim_id: "CLAIM" });
  } } });
  assert.deepEqual(claims, [{ path, owner_task_id: "TICKET-OLD", claim_id: "CLAIM" }]);
  assert.equal(reads.length, 1);
  assert(reads[0].endsWith(`/${createHash("sha256").update(path).digest("hex")}.json`));
});

test("legacy claims without claim_id retain their competing ticket owner", async () => {
  const path = "backend/src/server.js";
  const job = { request: { project_id: "P" }, evidence: [{ path }] };
  const claims = await inspectBlockerFileClaims({ job, fileService: { readFile: async () => JSON.stringify({ path, task_id: "TICKET-OLD" }) } });
  assert.deepEqual(claims, [{ path, owner_task_id: "TICKET-OLD", claim_id: null }]);
  for (const claim_id of [null, "", 123]) {
    await assert.rejects(inspectBlockerFileClaims({ job, fileService: { readFile: async () => JSON.stringify({ path, task_id: "TICKET-OLD", claim_id }) } }), /invalid identity/);
  }
});

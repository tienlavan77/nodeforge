// Verifies repair preparation archives terminal evidence, preserves source and recovers partial journal writes.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketExecutionContextStore } from "../../src/modules/supervisor/ticket-execution-context.js";
import { createTicketChangeLedger } from "../../src/modules/supervisor/ticket-change-ledger.js";
import { loadCompletedReviewSource, prepareCompletedReviewRepair } from "../../src/modules/supervisor/completed-review-repair-workspace.js";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";

// Seeds an integrated root ticket while leaving unrelated dirty source untouched.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-completed-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = createFileService({ projectRoot: root });
  const hash = (value) => createHash("sha256").update(value).digest("hex");
  const scope = hash("PROJECT-1");
  const manifestPath = `.forge/runtime/ticket-changes/${scope}/tickets/${hash("T")}.json`;
  const contextPath = `.forge/runtime/ticket-execution-contexts/${scope}/T.json`;
  const manifest = { task_id: "T", project_id: "PROJECT-1", state: "closed", revision: 8, entries: {}, commits: { 8: "a".repeat(40) }, pending_commit: null };
  const contexts = createTicketExecutionContextStore({ projectId: "PROJECT-1", projectRoot: root, fileService: files });
  const context = { task_id: "T", project_id: "PROJECT-1", version: 3, state: "terminal", base_sha: "b".repeat(40),
    ...contexts.manifestIdentity(manifest), review_commit_sha: "a".repeat(40), verification_artifact_id: "ART-1" };
  await files.atomicWrite({ path: manifestPath, content: JSON.stringify(manifest) });
  await files.atomicWrite({ path: contextPath, content: JSON.stringify(context) });
  await files.atomicWrite({ path: ".forge/runtime/ticket-integrations/T.json", content: JSON.stringify({ status: "completed", commit: context.review_commit_sha, artifact_id: "ART-1" }) });
  await files.atomicWrite({ path: "source.js", content: "unrelated dirty source" });
  const ledger = createTicketChangeLedger({ projectId: "PROJECT-1", fileService: files });
  const options = { taskId: "T", projectId: "PROJECT-1", fileService: files, executionContexts: contexts, ledger,
    binding: { commit: context.review_commit_sha, artifact_id: "ART-1" }, cycleId: "cycle-1" };
  return { root, files, contexts, contextPath, options, context, ledger };
}

test("repair archives integrated evidence and keeps terminal update guard intact", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.contexts.update("T", 3, { state: "coding" }), { code: "TICKET_CONTEXT_TERMINAL" });
  const result = await prepareCompletedReviewRepair(f.options);
  const receipt = JSON.parse(await f.files.readFile({ path: result.receipt }));
  assert.equal(receipt.context.state, "terminal");
  assert.equal(receipt.manifest.state, "closed");
  assert.equal((await f.contexts.load("T")).state, "coding");
  assert.equal((await f.ledger.load("T")).revision, 9);
  assert.equal((await f.ledger.load("T")).state, "active");
  assert.equal(await readFile(join(f.root, "source.js"), "utf8"), "unrelated dirty source");
  await assert.rejects(f.files.readFile({ path: ".forge/runtime/ticket-integrations/T.json" }), { code: "ENOENT" });
  assert.deepEqual(await prepareCompletedReviewRepair(f.options), result);
});

test("partial preparation recovers without discarding original evidence or duplicating a cycle", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const files = { ...f.files, atomicWrite: async (input) => {
    if (input.path === f.contextPath && fail) { fail = false; throw new Error("simulated crash"); }
    return f.files.atomicWrite(input);
  } };
  await assert.rejects(prepareCompletedReviewRepair({ ...f.options, fileService: files }), /simulated crash/);
  assert.equal((await f.contexts.load("T")).state, "terminal");
  const result = await prepareCompletedReviewRepair(f.options);
  assert.equal(JSON.parse(await f.files.readFile({ path: result.receipt })).context.version, 3);
  assert.equal((await f.contexts.load("T")).version, 4);
});

test("a repair cycle enters blocking review despite historical soft policy", async () => {
  const f = automaticReviewFixture({ gate: "off" });
  await f.complete();
  const old = (await f.queueStore.list("agent.request"))[0];
  f.request.ticket.execution_policy.review_gate = "on";
  f.request.payload.review_cycle_id = "owner-cycle";
  f.revise();
  assert.equal((await f.complete()).status, "completed");
  assert.equal(f.calls, 1);
  assert.equal(old.review_policy.gate, "off");
  assert.equal((await f.queueStore.list("agent.request")).at(-1).review_policy.gate, "on");
});

// Keeps archived provenance bound to the exact integrated ticket and baseline.
test("repair source history validates archived identity and rejects tampered manifests", async (t) => {
  const f = await fixture(t);
  const result = await prepareCompletedReviewRepair(f.options);
  const options = { ...f.options, context: await f.contexts.load("T") };
  assert.equal((await loadCompletedReviewSource(options)).length, 1);
  const receipt = JSON.parse(await f.files.readFile({ path: result.receipt }));
  receipt.manifest.entries["foreign.js"] = { initial_sha: "foreign", latest_sha: "foreign" };
  await f.files.atomicWrite({ path: result.receipt, content: JSON.stringify(receipt), replace: true });
  await assert.rejects(loadCompletedReviewSource(options), { code: "TICKET_CONTRACT_SOURCE_CONFLICT" });
});

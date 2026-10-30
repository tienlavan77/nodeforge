/** Separates historical contract authority from mutable implementation source.
 * Source observation must let agents review live drift without treating it as
 * new approval, accepting it as ticket work, or losing genuine contract checks. */
import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "../fixtures/ticket-contract-source-fixture.js";
import { preflightBlockerContract } from "../../src/modules/supervisor/blocker/blocker-contract-preflight.js";
import { createBlockerSourceResume } from "../../src/modules/supervisor/blocker/blocker-source-resume.js";
import { buildBlockerTicketProgress } from "../../src/modules/supervisor/blocker/blocker-ticket-progress.js";

test("unrelated shared-root changes do not invalidate the approved contract or restart Coder", async (t) => {
  const f = await fixture(t);
  f.workspace.changeLedger.observe = () => f.ledger.observe("T");
  await f.write();
  const path = "backend/concurrent.js";
  await f.files.atomicWrite({ path, content: "base", replace: true });
  await f.ledger.write({ taskId: "T", path, before: "base", after: "ticket" });
  await f.files.atomicWrite({ path, content: "external", replace: true });
  assert.equal((await f.verify(f.ref)).provenance, "ticket_owned_changes");
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  assert.equal(f.events.length, 0);
  assert.equal(f.checkpoint().last_completed_turn, 33);
  assert.equal(await f.files.readFile({ path }), "external");
});

test("changed contract implementation is agent context, not a new approval or accepted code", async (t) => {
  const f = await fixture(t);
  f.workspace.changeLedger.observe = () => f.ledger.observe("T");
  await f.write();
  await f.files.atomicWrite({ path: f.path, content: "external", replace: true });
  const progress = await buildBlockerTicketProgress({ job: { request: f.request, history: [] }, checkpoint: f.checkpoint(), workspace: f.workspace });
  const receipt = progress.contract_source[0];
  assert.equal(receipt.status, "validated");
  assert.equal(receipt.source_review_required, true);
  assert.equal(receipt.provenance, "observed_source_changes");
  assert.equal(receipt.baseline_sha256, f.ref.sha256);
  assert.deepEqual(progress.changed_files, []);
  assert.equal(progress.source_changes[0].path, f.path);
  assert.equal(progress.criteria[0].verification, "unverified");
  assert.equal(await preflightBlockerContract(f.request, f.options), false);
  await assert.rejects(f.verify({ ...f.ref, sha256: "0".repeat(64) }), { code: "BLOCKER_DISPOSITION_INVALID" });
});

test("parked source mismatch returns to SL once and preserves the settled AM answer and Coder turn", async (t) => {
  const f = await fixture(t);
  f.workspace.changeLedger.observe = () => f.ledger.observe("T");
  const answer = { disposition: { action: "resolved", guidance: "Implement the approved scoped repair." } };
  const job = { id: "J", request: f.request, history: [], outcome_reason: "TICKET_SOURCE_CHANGED", stage: "sprint_leader",
    architecture_response: answer, resolution: { action: "resolved" }, validation_feedback: [{ reason: "TICKET_SOURCE_CHANGED" }] };
  const refresh = createBlockerSourceResume({ inspect: async () => ({ workspace: f.workspace, checkpoint: f.checkpoint() }) });
  assert.equal(await refresh(job), true);
  assert.equal(await refresh(job), false);
  assert.equal(job.architecture_response, answer);
  assert.equal(job.history.length, 1);
  assert.equal(job.history[0].previous_resolution.action, "resolved");
  assert.equal(job.validation_feedback, undefined);
  assert.equal(f.checkpoint().last_completed_turn, 33);
});

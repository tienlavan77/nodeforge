/** Proves installed commit-recovery capabilities rearm an informational tooling
 * wait once while preserving AM decisions, Coder checkpoints and actual denials. */
import assert from "node:assert/strict";
import test from "node:test";
import { createBlockerReconciliationRefresh } from "../../src/modules/supervisor/blocker/blocker-reconciliation-refresh.js";
import { blockerRuntimeCapabilities, refreshBlockerRuntimeCapabilities } from "../../src/modules/supervisor/blocker/blocker-runtime-capabilities.js";

/** Models a typed external tooling question after AM has already answered;
 * arbitrary narrative is deliberately irrelevant to the recovery decision. */
function parked() {
  const resolution = { action: "reconciliation_required", summary: "An operation is not documented.", guidance: "Preserve the existing commit.",
    reconciliation: { kind: "tooling", waiting_for: [{ owner: "external", operation: "execute", question: "What operation is installed?" }],
      owner_request: { kind: "information", question: "What operation is installed?", context: "Runtime capability information is missing." } } };
  return { id: "J", request: { task_id: "T", project_id: "P", payload: { execution_id: "E" } }, history: [],
    stage: "sprint_leader", status: "reconciliation_required", outcome_reason: "technical_reconciliation_waiting_for_evidence",
    reason_code: "COMMIT_MISSING", resolution, ticket_progress: { commit_sha: "retained-commit" },
    architecture_response: { execution_id: "E", disposition: structuredClone(resolution) },
    validation_feedback: [{ path: "/", message: "Operation information unavailable." }] };
}

test("installed recovery operation returns a parked tooling question to SL once across restart", async () => {
  const job = parked(), original = structuredClone(job), events = [];
  const workspace = { gitService: { reconcileRestoredCommit: () => assert.fail("Discovery must not execute recovery") } };
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace }), clock: () => 123, projectLogger: (event) => events.push(event) });
  assert.equal(await refresh(job), true);
  assert.equal(job.stage, "sprint_leader"); assert.equal(job.resolution, undefined);
  assert.deepEqual(job.architecture_response, original.architecture_response); assert.deepEqual(job.request, original.request);
  assert.equal(job.ticket_progress.commit_sha, "retained-commit");
  assert.deepEqual(job.ticket_progress.runtime_capabilities, blockerRuntimeCapabilities(workspace));
  assert.deepEqual(job.history[0].previous_resolution, original.resolution);
  assert.equal(events[0].event_name, "supervisor.blocker_runtime_capabilities_refreshed");
  const restarted = structuredClone(job);
  restarted.resolution = original.resolution;
  assert.equal(await refresh(restarted), false);
  assert.equal(events.length, 1);
});

test("capability facts do not reopen authorization decisions, stopped work, unknown outcomes or other questions", async () => {
  for (const change of [
    (job) => { job.resolution.reconciliation.owner_request.kind = "tool_authorization"; },
    (job) => { job.status = "cancelled"; },
    (job) => { job.stage = "architecture_manager"; },
    (job) => { job.outcome_reason = "provider_outcome_unknown"; },
    (job) => { job.resolution.reconciliation.kind = "technical_design"; },
    (job) => { job.resolution.reconciliation.waiting_for[0].owner = "coder"; }
  ]) {
    const job = parked(); change(job);
    const original = structuredClone(job);
    const refresh = createBlockerReconciliationRefresh({ inspect: async () => null });
    assert.equal(await refresh(job), false); assert.deepEqual(job, original);
  }
});

test("a replaced execution or runtime without the installed operation retains its original question", async () => {
  for (const authority of [null, { workspace: { gitService: {} } }]) {
    const job = parked(), original = structuredClone(job);
    const refresh = createBlockerReconciliationRefresh({ inspect: async () => authority });
    assert.equal(await refresh(job), false); assert.deepEqual(job, original);
  }
});

test("new dependency dispatcher returns a settled dependency wait to SL once without dispatching Coder", async () => {
  const job = parked();
  job.resolution.reconciliation = { kind: "dependency", waiting_for: [
    { owner: "coder", operation: "execute", question: "Repair the approved upstream ticket first." }
  ] };
  const original = structuredClone(job);
  const runtimeCapabilities = { dependency_repair: { supported: true, action: "dependency_requested",
    owner: "sprint_leader", boundary: "approved_upstream_same_project_sprint" } };
  const events = [];
  const refresh = createBlockerReconciliationRefresh({ inspect: async () => ({ workspace: {} }), runtimeCapabilities,
    clock: () => 123, projectLogger: (event) => events.push(event) });
  assert.equal(await refresh(job), true);
  assert.equal(job.stage, "sprint_leader"); assert.equal(job.resolution, undefined);
  assert.equal(job.dependency_request_id, undefined);
  assert.deepEqual(job.architecture_response, original.architecture_response);
  assert.deepEqual(job.request, original.request);
  assert.deepEqual(job.ticket_progress.runtime_capabilities, runtimeCapabilities);
  assert.deepEqual(job.history[0].previous_resolution, original.resolution);
  const restarted = structuredClone(job);
  restarted.resolution = original.resolution;
  assert.equal(await refreshBlockerRuntimeCapabilities(restarted, { inspect: async () => ({ workspace: {} }),
    runtimeCapabilities, clock: () => 124, projectLogger: (event) => events.push(event) }), false);
  assert.equal(events.length, 1);
});

test("dependency capability refresh preserves Stop, active repairs and unresolved authority", async () => {
  for (const change of [
    (job) => { job.status = "cancelled"; },
    (job) => { job.outcome_reason = "provider_outcome_unknown"; },
    (job) => { job.architecture_response = null; },
    (job) => { job.architecture_response.execution_id = "OLD"; },
    (job) => { job.dependency_request_id = "ACTIVE"; },
    (job) => { job.stage = "architecture_manager"; }
  ]) {
    const job = parked(); job.resolution.reconciliation.kind = "dependency"; change(job);
    const original = structuredClone(job);
    assert.equal(await refreshBlockerRuntimeCapabilities(job, { inspect: async () => ({ workspace: {} }),
      runtimeCapabilities: { dependency_repair: { supported: true } } }), false);
    assert.deepEqual(job, original);
  }
  const job = parked(); job.resolution.reconciliation.kind = "dependency";
  assert.equal(await refreshBlockerRuntimeCapabilities(job, { inspect: async () => ({ workspace: {} }),
    runtimeCapabilities: { dependency_repair: { supported: false } } }), false);
  assert.equal(await refreshBlockerRuntimeCapabilities(job, { inspect: async () => null,
    runtimeCapabilities: { dependency_repair: { supported: true } } }), false);
});

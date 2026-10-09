// Verifies fresh-process production recovery preserves actual SQLite occupancy while a launch remains unresolved.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeDispatchStorage, openDispatchStorage, TICKET } from "../fixtures/ticket-dispatch-recovery-fixture.mjs";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";

const AGENT = "11111111-1111-4111-8111-111111111111";
const EXPECTED_SOURCES = {
  "modules/supervisor/production-runtime.js": "bf8af53b00e8455c860c9ae5a8304241676b758e26f7f1246d87c77cc6fb720e",
  "modules/supervisor/ticket-launch-recovery.js": "be74b0222137620a5111e1fd10edf68c1f5ca7778a232355fc67237bd6eddf69",
  "modules/agent/agent-occupancy-store.js": "a95defc74f2bf83110a7eb7c4e1e96ac9ad34c2bb3c28ecab1b8ec990dd1a12c",
  "modules/supervisor/durable-queue.js": "ab7b69fdb8f3e3a2065900fc56d459495d864391f52cfba41a30433c0998d951"
};

// Persists actual agent ownership and terminal/checkpoint snapshots before closing the original database connection.
async function seedRecovery(root, state, retained) {
  const storage = await openDispatchStorage(root);
  let runtime;
  try {
    const profiles = createAgentProfileStore({ database: storage.database });
    profiles.create({ agent_id: AGENT, agent_name: "Recovery Coder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: `runtime:${AGENT}:api-key`, enabled: true, status: "ready", created_at: "2026-10-09T00:00:00Z", updated_at: "2026-10-09T00:00:00Z" });
    const occupancy = createAgentOccupancyStore({ database: storage.database, profiles });
    const claim = await occupancy.claim({ agentId: AGENT, taskId: TICKET.id, supervisorId: `SUP-${TICKET.id}` });
    assert.ok(claim);
    if (retained) {
      const basis = storage.registry.get(TICKET.sprint_id);
      storage.store.beginExecution(TICKET.id, { executionId: "RUN-UNKNOWN", basis, expectedVersion: storage.store.get(TICKET.id).version, dependencyExpectations: [] });
      storage.store.claimExecutionLaunch(TICKET.id, { executionId: "RUN-UNKNOWN", basis, requestId: "REQ-UNKNOWN", jobId: "JOB-UNKNOWN", supervisorId: claim.supervisor_id, agentId: AGENT, claimId: claim.claim_id, validate: () => {} });
    }
    runtime = createProductionSupervisorRuntime({ fileService: storage.files, projectRoot: root, root: "occupancy-recovery", ticketStatusStore: storage.store, sprintRegistry: storage.registry, agentOccupancy: occupancy, autoStartWorkers: false, logger: { info() {}, debug() {} }, gitService: { status: async () => "" } });
    await runtime.agentCheckpoints.save({ task_id: TICKET.id, status: "completed", agent_id: AGENT });
    if (state !== "checkpoint") await runtime.stateStore.save({ task_id: TICKET.id, supervisor_id: claim.supervisor_id, state, pending_request: {}, updated_at: new Date().toISOString() });
    return claim;
  } finally {
    runtime?.senderWorker.stop(); runtime?.collectorWorkerLoop.stop(); runtime?.verificationWorkerLoop.stop();
    await storage.database.close();
  }
}

for (const [state, retained] of [["checkpoint", true], ["COMPLETED", true], ["FAILED", true], ["NEEDS_HUMAN_REVIEW", true], ["checkpoint", false], ["COMPLETED", false]]) {
  test(`fresh process ${state} recovery ${retained ? "retains unresolved" : "releases unclaimed-launch"} persistent occupancy`, { timeout: 20000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "persistent-occupancy-recovery-"));
    let reopened;
    try {
      await initializeDispatchStorage(root);
      const claim = await seedRecovery(root, state, retained);
      const worker = fileURLToPath(new URL("../fixtures/ticket-occupancy-recovery-worker.mjs", import.meta.url));
      const { stdout } = await promisify(execFile)(process.execPath, [worker, root, AGENT, claim.claim_id], { timeout: 15000 });
      const result = JSON.parse(stdout.trim());
      assert.notEqual(result.pid, process.pid);
      assert.equal(result.node_version, process.version);
      assert.deepEqual(result.source_identities, EXPECTED_SOURCES);
      assert.equal(result.provider_calls, 0);
      assert.deepEqual(result.agent_requests, []);
      assert.equal(result.profile_status, retained ? "working" : "ready");
      if (retained) {
        assert.equal(result.active_claim.claim_id, claim.claim_id);
        assert.equal(result.occupancy_row.released_at, null);
        assert.equal(result.occupancy_row.release_reason, null);
        assert.equal(result.launch_claim.claim_id, claim.claim_id);
        assert.equal(result.events.some((event) => event.type === "task.needs_human_review"), false);
        assert.ok(result.diagnostics.some((entry) => entry.event_name === "supervisor.launch_reconciliation_required"));
      } else {
        assert.equal(result.active_claim, null);
        assert.ok(result.occupancy_row.released_at);
        assert.equal(result.occupancy_row.release_reason, state === "checkpoint" ? "review_interrupted" : "recovered_completed");
      }
      reopened = await openDispatchStorage(root);
      const row = reopened.database.all("SELECT * FROM agent_occupancy WHERE claim_id = ?", [claim.claim_id])[0];
      assert.equal(Boolean(row.released_at), !retained);
      assert.equal(createAgentProfileStore({ database: reopened.database }).getById(AGENT).status, retained ? "working" : "ready");
      // The child supplies raw observations to the parent test; verification service stdout availability is a separate gate.
      console.log(JSON.stringify({ evidence: "persistent-occupancy-recovery", state, retained, ...result }));
    } finally { await reopened?.database.close(); await rm(root, { recursive: true, force: true }); }
  });
}

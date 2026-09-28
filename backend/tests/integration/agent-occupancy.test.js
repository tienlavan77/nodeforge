// Verifies exclusive Coder claims survive competing supervisors, retries, and restart.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";

// Claims one Coder once while an independent ready Coder can serve another ticket.
test("Coder claims are exclusive, durable, and released by their owning Supervisor", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-occupancy-"));
  let database = await openIndexDatabase(root);
  try {
    const profiles = createAgentProfileStore({ database });
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    for (const agentId of [first, second]) profiles.create({ agent_id: agentId, agent_name: "Coder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: `runtime:${agentId}:api-key`, enabled: true, status: "ready", created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" });
    const events = [];
    const config = { sync: () => {} };
    let store = createAgentOccupancyStore({ database, profiles, configuration: config, onChanged: (event) => events.push(event) });
    const [winner, loser] = await Promise.all([store.claim({ agentId: first, taskId: "T-A", supervisorId: "SV-A" }), store.claim({ agentId: first, taskId: "T-B", supervisorId: "SV-B" })]);
    assert.ok(winner);
    assert.equal(loser, null);
    assert.equal(profiles.getById(first).status, "working");
    const activeProfile = profiles.getById(first);
    profiles.update({ ...activeProfile, status: "ready", updated_at: "2026-09-28T00:01:00Z" });
    assert.equal(profiles.getById(first).status, "working");
    assert.throws(() => profiles.delete(first), /Cannot delete an agent while a ticket owns its claim/);
    const other = await store.claim({ agentId: second, taskId: "T-B", supervisorId: "SV-B" });
    assert.ok(other);
    assert.equal((await store.claim({ agentId: first, taskId: "T-A", supervisorId: "SV-A" })).claim_id, winner.claim_id);
    assert.equal(await store.release({ claimId: winner.claim_id, taskId: "T-A", supervisorId: "SV-B", reason: "accepted" }), null);
    await database.close();
    database = await openIndexDatabase(root);
    const restartedProfiles = createAgentProfileStore({ database });
    store = createAgentOccupancyStore({ database, profiles: restartedProfiles, configuration: config, onChanged: (event) => events.push(event) });
    assert.equal(store.getByTask("T-A").claim_id, winner.claim_id);
    assert.equal(restartedProfiles.getById(first).status, "working");
    const released = await store.release({ claimId: winner.claim_id, taskId: "T-A", supervisorId: "SV-A", reason: "accepted" });
    assert.equal(released.status, "ready");
    assert.equal(await store.release({ claimId: winner.claim_id, taskId: "T-A", supervisorId: "SV-A", reason: "accepted" }), null);
    assert.equal(restartedProfiles.getById(first).status, "ready");
    assert.deepEqual(events.map((event) => event.status), ["working", "working", "ready"]);
  } finally { await database?.close(); await rm(root, { recursive: true, force: true }); }
});

// Post-commit publication failures cannot make callers retry an already committed claim.
test("persisted claims survive status notification errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-occupancy-event-"));
  const database = await openIndexDatabase(root);
  try {
    const profiles = createAgentProfileStore({ database });
    const agentId = "33333333-3333-4333-8333-333333333333";
    profiles.create({ agent_id: agentId, agent_name: "Coder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: `runtime:${agentId}:api-key`, enabled: true, status: "ready", created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" });
    const failures = [];
    const store = createAgentOccupancyStore({ database, profiles, configuration: { sync: () => { throw new Error("sync unavailable"); } }, onChanged: () => { throw new Error("stream unavailable"); }, logger: { error: (_message, details) => failures.push(details) } });
    const claim = await store.claim({ agentId, taskId: "T-EVENT", supervisorId: "SV-EVENT" });
    assert.equal(store.getByTask("T-EVENT").claim_id, claim.claim_id);
    assert.equal(profiles.getById(agentId).status, "working");
    assert.deepEqual(failures.map((entry) => entry.step), ["configuration_sync", "event_publish"]);
    await store.release({ claimId: claim.claim_id, taskId: "T-EVENT", supervisorId: "SV-EVENT", reason: "accepted" });
    assert.equal(profiles.getById(agentId).status, "ready");
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Keeps a Reviewer working beside the Coder until its own review claim is released.
test("Reviewer claim is exclusive and independent from the Coder claim on one ticket", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-review-occupancy-"));
  const database = await openIndexDatabase(root);
  try {
    const profiles = createAgentProfileStore({ database });
    const coderId = "44444444-4444-4444-8444-444444444444";
    const reviewerId = "55555555-5555-4555-8555-555555555555";
    for (const [agentId, role] of [[coderId, "coder"], [reviewerId, "reviewer"]]) profiles.create({ agent_id: agentId, agent_name: role, role, gateway_url: "https://gateway.test/v1", credential_ref: `runtime:${agentId}:api-key`, enabled: true, status: "ready", created_at: "2026-09-28T00:00:00Z", updated_at: "2026-09-28T00:00:00Z" });
    const events = [];
    const store = createAgentOccupancyStore({ database, profiles, onChanged: (event) => events.push(event) });
    const coder = await store.claim({ agentId: coderId, taskId: "T-REVIEW", supervisorId: "SV-1" });
    const reviewer = await store.claim({ agentId: reviewerId, taskId: "T-REVIEW", supervisorId: "SV-1", role: "reviewer" });
    assert.ok(coder && reviewer);
    assert.equal(profiles.getById(reviewerId).status, "working");
    assert.equal(store.getByTask("T-REVIEW", "reviewer").claim_id, reviewer.claim_id);
    assert.equal(await store.claim({ agentId: reviewerId, taskId: "T-OTHER", supervisorId: "SV-2", role: "reviewer" }), null);
    await store.release({ claimId: reviewer.claim_id, taskId: "T-REVIEW", supervisorId: "SV-1", reason: "review_completed" });
    assert.equal(profiles.getById(reviewerId).status, "ready");
    assert.equal(profiles.getById(coderId).status, "working");
    assert.deepEqual(events.filter((event) => event.agent_id === reviewerId).map((event) => event.status), ["working", "ready"]);
  } finally { await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Verifies AM-approved shared-agent project attribution, nullable legacy recovery, and existing history/memory isolation.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";
import { createAgentOccupancyNotifications } from "../../src/modules/agent/agent-occupancy-notifications.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";
import { createProjectLogService } from "../../src/core/project-log-service.js";
import { createEventPublisher } from "../../src/modules/events/event-publisher.js";
import { createEventStore } from "../../src/modules/events/event-store.js";
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";
import { createHistoryStore } from "../../src/modules/history/history-store.js";
import { createTaskSummaryStore } from "../../src/modules/history/task-summary-store.js";
import { createProjectMemoryStore } from "../../src/modules/history/project-memory-store.js";
import { createMemoryRetriever } from "../../src/modules/history/memory-retriever.js";

const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

// Seeds actual persistent profiles so exclusivity tests execute the production transaction path.
function seedProfiles(database) {
  const profiles = createAgentProfileStore({ database });
  for (const agentId of [FIRST, SECOND]) profiles.create({ agent_id: agentId, agent_name: "Shared Coder", role: "coder", gateway_url: "https://gateway.test/v1", credential_ref: `runtime:${agentId}:api-key`, enabled: true, status: "ready", created_at: "2026-10-20T00:00:00Z", updated_at: "2026-10-20T00:00:00Z" });
  return profiles;
}

// Exercises concurrent ownership, restart, real published history, and failure-log attribution across projects.
test("shared agents retain claim-derived project attribution across concurrent work and restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "multi-project-agent-"));
  let database = await openIndexDatabase(root);
  const subscriptions = createSubscriptionRegistry();
  const history = createHistoryStore({ subscriptions, database: { run: (...args) => database.run(...args), all: (...args) => database.all(...args) } });
  const publisher = createEventPublisher({ store: createEventStore(), subscriptions });
  const logs = createProjectLogService({ projectRoot: root });
  const events = [];
  const internalBus = new EventEmitter();
  internalBus.on("agent.status_changed", (event) => events.push(event));
  const notifications = createAgentOccupancyNotifications({ projectId: "PROJECT-STARTUP", logEvent: logs.logEvent, internalBus, executionActivity: () => {}, eventPublisher: publisher });
  try {
    const profiles = seedProfiles(database);
    let occupancy = createAgentOccupancyStore({ database, profiles, ...notifications, configuration: { sync: () => { throw new Error("controlled sync failure"); } } });
    const firstInput = { agentId: FIRST, taskId: "TASK-A", supervisorId: "SUP-A", projectId: "PROJECT-A" };
    const secondInput = { agentId: SECOND, taskId: "TASK-B", supervisorId: "SUP-B", projectId: "PROJECT-B" };
    const [first, rejected, second] = await Promise.all([
      occupancy.claim(firstInput), occupancy.claim({ ...secondInput, agentId: FIRST }), occupancy.claim(secondInput)
    ]);
    assert.equal(rejected, null);
    assert.equal(first.project_id, "PROJECT-A");
    assert.equal(second.project_id, "PROJECT-B");
    assert.equal(await occupancy.claim({ ...firstInput, projectId: "PROJECT-B" }), null);
    assert.equal(occupancy.getByTask("TASK-A", "coder", { projectId: "PROJECT-B" }), null);
    assert.equal(await occupancy.release({ claimId: first.claim_id, taskId: "TASK-A", supervisorId: "SUP-A", projectId: "PROJECT-B", reason: "wrong_project" }), null);
    assert.equal((await occupancy.claim(firstInput)).created, false);
    await assert.rejects(occupancy.claim({ ...firstInput, projectId: " " }), /non-empty project/);
    await assert.rejects(occupancy.claim({ ...firstInput, projectId: 42 }), /non-empty project/);
    await database.close();
    database = await openIndexDatabase(root);
    occupancy = createAgentOccupancyStore({ database, profiles: createAgentProfileStore({ database }), ...notifications, configuration: { sync: () => { throw new Error("controlled restart sync failure"); } } });
    assert.equal(occupancy.getByTask("TASK-A").project_id, "PROJECT-A");
    assert.equal(occupancy.getByTask("TASK-B").project_id, "PROJECT-B");
    const released = await occupancy.release({ claimId: first.claim_id, taskId: "TASK-A", supervisorId: "SUP-A", projectId: "PROJECT-A", reason: "completed" });
    assert.equal(released.project_id, "PROJECT-A");
    const reused = await occupancy.claim({ agentId: FIRST, taskId: "TASK-B-NEXT", supervisorId: "SUP-B-NEXT", project_id: "PROJECT-B" });
    assert.equal(reused.project_id, "PROJECT-B");
    assert.deepEqual(events.map((event) => [event.project_id, event.payload.project_id, event.metadata.project_id]), [
      ["PROJECT-A", "PROJECT-A", "PROJECT-A"], ["PROJECT-B", "PROJECT-B", "PROJECT-B"],
      ["PROJECT-A", "PROJECT-A", "PROJECT-A"], ["PROJECT-B", "PROJECT-B", "PROJECT-B"]
    ]);
    for (const projectId of ["PROJECT-A", "PROJECT-B"]) {
      const records = history.getByProject(projectId);
      assert.ok(records.length > 0);
      assert.ok(records.every((record) => record.project_id === projectId));
      assert.ok(records.every((record) => projectId === "PROJECT-A" ? record.task_id === "TASK-A" : record.task_id.startsWith("TASK-B")));
      const captured = await logs.readLogEvents({ project_id: projectId });
      assert.equal(captured.warnings.length, 0);
      assert.ok(captured.events.length > 0);
      assert.ok(captured.events.every((event) => event.project_id === projectId && event.payload.project_id === projectId));
    }
    for (const projectId of ["PROJECT-A", "PROJECT-B"]) publisher.publish({ event_id: `EVT-FACT-${projectId}`, type: "workflow.completed", timestamp: new Date().toISOString(), project_id: projectId, task_id: `TASK-FACT-${projectId}`, payload: { long_term_fact: `Architecture decision for ${projectId}` } });
    const summaries = createTaskSummaryStore({ history });
    for (const projectId of ["PROJECT-A", "PROJECT-B"]) summaries.build(`TASK-FACT-${projectId}`);
    const memory = createProjectMemoryStore({ summaries });
    memory.build("PROJECT-A"); memory.build("PROJECT-B");
    const retriever = createMemoryRetriever({ memory });
    for (const projectId of ["PROJECT-A", "PROJECT-B"]) assert.deepEqual(retriever.retrieve({ projectId, taskId: "TASK-NEXT", query: "architecture" }).relevant_facts, [`Architecture decision for ${projectId}`]);
    history.compact({ projectId: "PROJECT-A", taskIds: ["TASK-A"] });
    const reopenedHistory = createHistoryStore({ subscriptions: createSubscriptionRegistry(), database });
    assert.equal(reopenedHistory.getByProject("PROJECT-A").length, 2);
    assert.deepEqual(reopenedHistory.getByProject("PROJECT-B"), []);
    reopenedHistory.close();
  } finally { history.close(); await database.close(); await rm(root, { recursive: true, force: true }); }
});

// Applies the retained AM nullable-column contract without assigning legacy occupancy to the startup project.
test("legacy migration preserves unattributed rows and project-aware restart recovery skips foreign claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "multi-project-agent-legacy-"));
  let database = await openIndexDatabase(root);
  let runtime;
  const diagnostics = [];
  const events = [];
  try {
    const profiles = seedProfiles(database);
    database.run("DROP TABLE agent_occupancy");
    database.run("CREATE TABLE agent_occupancy (claim_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, task_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'coder', supervisor_id TEXT NOT NULL, claimed_at TEXT NOT NULL, released_at TEXT, release_reason TEXT)");
    database.run("INSERT INTO agent_occupancy (claim_id, agent_id, task_id, supervisor_id, claimed_at) VALUES (?, ?, ?, ?, ?)", ["LEGACY", FIRST, "TASK-LEGACY", "SUP-LEGACY", "2026-10-01T00:00:00Z"]);
    const original = database.all("SELECT * FROM agent_occupancy")[0];
    let occupancy = createAgentOccupancyStore({ database, profiles, defaultProjectId: "PROJECT-A" });
    assert.deepEqual(database.all("SELECT * FROM agent_occupancy WHERE claim_id = 'LEGACY'")[0], { ...original, project_id: null });
    assert.equal((await occupancy.claim({ agentId: FIRST, taskId: "TASK-LEGACY", supervisorId: "SUP-LEGACY", projectId: "PROJECT-A" })).project_id, null);
    assert.equal(occupancy.getByTask("TASK-LEGACY", "coder", { projectId: "PROJECT-A" }), null);
    assert.equal(occupancy.getByTask("TASK-LEGACY", "coder", { projectId: null }).project_id, null);
    const foreign = await occupancy.claim({ agentId: SECOND, taskId: "TASK-FOREIGN", supervisorId: "SUP-FOREIGN", projectId: "PROJECT-B" });
    await database.close();
    database = await openIndexDatabase(root);
    occupancy = createAgentOccupancyStore({ database, profiles: createAgentProfileStore({ database }), defaultProjectId: "PROJECT-A", onChanged: (event) => events.push(event) });
    runtime = createProductionSupervisorRuntime({ fileService: createFileService({ projectRoot: root }), projectRoot: root, projectId: "PROJECT-A", root: "recovery", agentOccupancy: occupancy, autoStartWorkers: false, logger: { debug() {}, info() {} }, projectLogger: (entry) => diagnostics.push(entry), gitService: { status: async () => "" } });
    for (const [taskId, supervisorId] of [["TASK-LEGACY", "SUP-LEGACY"], ["TASK-FOREIGN", "SUP-FOREIGN"]]) await runtime.stateStore.save({ task_id: taskId, supervisor_id: supervisorId, state: "COMPLETED", pending_request: {}, updated_at: new Date().toISOString() });
    await runtime.recover();
    assert.equal(occupancy.getByTask("TASK-LEGACY"), null);
    assert.equal(occupancy.getByTask("TASK-FOREIGN").claim_id, foreign.claim_id);
    const legacy = database.all("SELECT * FROM agent_occupancy WHERE claim_id = 'LEGACY'")[0];
    assert.equal(legacy.project_id, null);
    assert.equal(legacy.claimed_at, original.claimed_at);
    assert.equal(legacy.release_reason, "recovered_completed");
    assert.equal(events[0].project_id, null);
    assert.equal(diagnostics.find((entry) => entry.event_name === "agent.occupancy_reconciled").payload.project_id, null);
    const next = await occupancy.claim({ agentId: FIRST, taskId: "TASK-NEW", supervisorId: "SUP-NEW" });
    assert.equal(next.project_id, "PROJECT-A");
  } finally {
    runtime?.senderWorker.stop(); runtime?.collectorWorkerLoop.stop(); runtime?.verificationWorkerLoop.stop();
    await database.close(); await rm(root, { recursive: true, force: true });
  }
});

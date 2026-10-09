// Reopens real persistent occupancy and runs production recovery in a fresh process without a live provider.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { openDispatchStorage, TICKET } from "./ticket-dispatch-recovery-fixture.mjs";
import { createAgentProfileStore } from "../../src/modules/agent/agent-profile-store.js";
import { createAgentOccupancyStore } from "../../src/modules/agent/agent-occupancy-store.js";
import { createProductionSupervisorRuntime } from "../../src/modules/supervisor/production-runtime.js";

// Emits runtime and source identities alongside persistent recovery observations for the parent test.
async function recoverPersistentOccupancy(root, agentId, claimId) {
  const storage = await openDispatchStorage(root);
  let runtime;
  try {
    const profiles = createAgentProfileStore({ database: storage.database });
    const occupancy = createAgentOccupancyStore({ database: storage.database, profiles });
    const events = []; const diagnostics = []; let providerCalls = 0;
    runtime = createProductionSupervisorRuntime({ fileService: storage.files, projectRoot: root, root: "occupancy-recovery", ticketStatusStore: storage.store, sprintRegistry: storage.registry, agentOccupancy: occupancy, autoStartWorkers: false,
      logger: { info() {}, debug() {} }, projectLogger: (entry) => diagnostics.push(entry), gitService: { status: async () => "" },
      agentGateway: { request: async () => { providerCalls += 1; throw new Error("Recovery must not invoke the fixture provider"); } } });
    runtime.eventBus.subscribe("*", (event) => events.push(event));
    await runtime.recover();
    await runtime.recover();
    const sourceIdentities = {};
    for (const path of ["modules/supervisor/production-runtime.js", "modules/supervisor/ticket-launch-recovery.js", "modules/agent/agent-occupancy-store.js", "modules/supervisor/durable-queue.js"]) {
      sourceIdentities[path] = createHash("sha256").update(await readFile(new URL(`../../src/${path}`, import.meta.url))).digest("hex");
    }
    return { node_version: process.version, pid: process.pid, source_identities: sourceIdentities, active_claim: occupancy.getByTask(TICKET.id), occupancy_row: storage.database.all("SELECT * FROM agent_occupancy WHERE claim_id = ?", [claimId])[0], profile_status: profiles.getById(agentId).status, launch_claim: storage.store.get(TICKET.id)?.details.launch_claim, events, diagnostics, provider_calls: providerCalls, agent_requests: await runtime.queueStore.list("agent.request") };
  } finally {
    runtime?.senderWorker.stop(); runtime?.collectorWorkerLoop.stop(); runtime?.verificationWorkerLoop.stop();
    await storage.database.close();
  }
}

const result = await recoverPersistentOccupancy(process.argv[2], process.argv[3], process.argv[4]);
process.stdout.write(`${JSON.stringify(result)}\n`);

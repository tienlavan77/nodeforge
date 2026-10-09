// Exercises real approved dispatch across persistent crash boundaries without invoking a production provider.
import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { createDatabaseService } from "../../src/infrastructure/sqlite/database-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createTicketStatusStore } from "../../src/modules/projects/ticket-status-store.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";
import { createApprovedTicketDispatch } from "../../src/application/approved-ticket-dispatch.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createForgeToolRegistry } from "../../src/tools/index.js";
import { createRuntimeToolGovernance } from "../../src/modules/governance/runtime-tool-governance.js";

export const PROJECT = "PROJECT-DISPATCH";
export const TICKET = { id: "TICKET-DISPATCH", project_id: PROJECT, sprint_id: "SPRINT-DISPATCH", title: "Recover original dispatch", objective: "Do not redispatch after crash", dependencies: [], acceptance_criteria: ["Preserve original execution owner"] };

// Opens shared on-disk authority and queue evidence for the real RUN and restart processes.
export async function openDispatchStorage(root) {
  const database = await createDatabaseService({ dataDir: root, runtimeDir: "." });
  const files = createFileService({ projectRoot: root, allowPlanStorage: true });
  const plans = createHumanPlanStore({ projectId: PROJECT, database, fileService: files });
  const registry = createSprintRegistry({ projectId: PROJECT, database, plans });
  const store = createTicketStatusStore({ projectId: PROJECT, database });
  const queueStore = createFileQueueStore({ fileService: files });
  const queue = createDurableQueue({ name: "sender.handoff", store: queueStore });
  return { database, files, plans, registry, store, queueStore, queue };
}

// Creates an immutable approved test plan; this is fixture authority, never a production approval receipt.
export async function initializeDispatchStorage(root) {
  const storage = await openDispatchStorage(root);
  try {
    const content = { objective: TICKET.objective, outcome: "Recover dispatch", in_scope: "Execution", out_of_scope: "Migration", approach: "Retain original owner", components: ["RUN"], tickets: [TICKET.id], ticket_specs: [TICKET], dependencies: [], risks: [], assumptions: [], open_questions: [], evidence_refs: [TICKET.id], acceptance_criteria: TICKET.acceptance_criteria };
    const plan = await storage.plans.createRevision({ planId: "PLAN-DISPATCH", sprintId: TICKET.sprint_id, expectedRevision: 0, content });
    await storage.plans.decide({ planId: plan.plan_id, revision: 1, sha256: plan.sha256, decision: "approved", approverId: "FIXTURE-OWNER", actorRole: "project_owner" });
    await storage.registry.register({ sprintId: TICKET.sprint_id, position: 1, planId: plan.plan_id, revision: 1 });
    await storage.registry.setStatus({ sprintId: TICKET.sprint_id, status: "ready" });
    storage.store.create(TICKET.id);
  } finally { await storage.database.close(); }
}

// Pauses only the nominated durable boundary so the parent can kill a process deterministically.
async function pauseBoundary(stage, boundary) {
  if (stage !== boundary) return;
  process.send({ boundary });
  await new Promise(() => {});
}

// Runs shared RUN -> approved dispatch -> integration using SQLite, file queue and governed tool fixtures.
async function runDispatchWorker(root, stage) {
  const storage = await openDispatchStorage(root);
  const { database, files, registry, store, queueStore } = storage;
  try {
    const queue = createDurableQueue({ name: "sender.handoff", store: { ...queueStore, save: async (name, job) => {
      if (stage === "quarantine-failure" && job.status === "dead_letter") throw Object.assign(new Error("Controlled quarantine write failure"), { code: "QUARANTINE_WRITE_FAILED" });
      await queueStore.save(name, job);
      if (job.status === "queued") await pauseBoundary(stage, "queue-saved");
    } } });
    const profile = { agent_id: "claude-coder", role: "coder", provider: "claude", enabled: true, status: "ready" };
    const governance = createRuntimeToolGovernance({ database });
    const toolRegistry = createForgeToolRegistry({ projectRoot: root, fileService: files, protocolStorage: { get: async () => null }, governance });
    const integration = createNodeforgeTaskIntegration({
      projectRoot: root, supervisorManager: { startTask: async () => ({}) },
      eventBus: { publish: async (event) => appendFile(join(root, "outcomes.jsonl"), `${JSON.stringify(event)}\n`) },
      agentResolver: { list: () => [profile], resolveAvailable: () => profile },
      agentOccupancy: { getByTask: () => null, claim: async () => ({ claim_id: "CLAIM-DISPATCH" }), release: async () => appendFile(join(root, "releases.txt"), "released\n") },
      ticketStatusStore: { ...store, claimExecutionLaunch: (id, input) => {
        const receipt = store.claimExecutionLaunch(id, input);
        if (stage === "launch-claimed") { process.send({ boundary: stage }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
        return receipt;
      } },
      sprintRegistry: registry, handoffQueue: queue, resolveTicketWorkspace: async () => null,
      claudeSdkGateway: { execute: async (request) => {
        assert.ok(request.options.allowedTools.includes("mcp__forge__read_file"));
        const receipt = store.get(TICKET.id).details.launch_claim;
        assert.equal(receipt.state, "launch_claimed");
        await appendFile(join(root, "launches.txt"), `${receipt.execution_id}\n`);
        if (stage === "quarantine-failure") throw Object.assign(new Error("Unknown provider result"), { code: "PROVIDER_UNKNOWN" });
        await pauseBoundary(stage, "provider");
        throw new Error("Fixture provider must remain paused");
      } }, toolRegistry, runtimeGovernance: governance
    });
    const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket: TICKET }) }, sprintRegistry: registry, ticketStatusStore: store,
      checkpoints: { load: async () => null, clear: async () => pauseBoundary(stage, "execution-claimed") },
      protocolStorage: { clearTask: async () => {} }, conversationStateStore: { clear: async () => {} },
      dispatchTask: createApprovedTicketDispatch({ projectId: PROJECT, sprintRegistry: registry, ticketStatusStore: store, integration }) });
    await dispatch({ projectId: PROJECT, ticketId: TICKET.id, dependencyExpectations: [] });
    process.send({ result: "unexpected_completion" });
  } catch (error) {
    process.send({ error: { code: error.code, retryable: error.retryable, cause_code: error.cause?.code, reconciliation_error: error.cause?.reconciliation_error, message: error.message } });
  } finally { await database.close(); }
}

if (process.argv[2] === "worker") {
  // Keep IPC referenced while a durable boundary is paused; start only after the parent installs observers.
  process.on("message", () => {});
  await new Promise((resolve) => process.once("message", resolve));
  await runDispatchWorker(process.argv[3], process.argv[4]);
  process.disconnect();
}

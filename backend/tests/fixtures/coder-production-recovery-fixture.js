// Exercises real Coder SDK integration, file recovery storage and launch ownership without a live provider.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createFileQueueStore } from "../../src/modules/supervisor/file-queue-store.js";
import { createDurableQueue } from "../../src/modules/supervisor/durable-queue.js";
import { createAgentExecutionCheckpointStore } from "../../src/modules/agent/agent-execution-checkpoint.js";
import { createNodeforgeTaskIntegration } from "../../src/modules/supervisor/nodeforge-task-integration.js";
import { createCoderRecoveryRuntime } from "../../src/modules/supervisor/coder-recovery-runtime.js";
import { sdkFailureEvidence } from "../../src/modules/agent/sdk-failure-evidence.js";
import { ConfigurationError } from "../../src/shared/errors.js";

export const BASIS = { project_id: "P", sprint_id: "SPRINT", plan_id: "PLAN", plan_revision: 1, plan_path: "plans/p.md", plan_sha256: "a".repeat(64), version: 1 };
export const TICKET = { id: "TASK", project_id: "P", sprint_id: "SPRINT", required_role: "coder", title: "Fix handler", objective: "Fix handler", dependencies: [], acceptance_criteria: ["Handler works"] };

// Creates process-reconstructible recovery services backed by real locked JSON and checkpoint files.
export async function coderProductionRecoveryFixture({ behavior } = {}) {
  const base = resolve(".forge/test-tmp");
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "production-retry-"));
  const fileService = createFileService({ projectRoot: root });
  const store = createFileQueueStore({ fileService });
  const checkpoints = createAgentExecutionCheckpointStore({ fileService });
  let now = 1000;
  let invocations = 0;
  let integrations = 0;
  let claim;
  let cancelled = false;
  let ready = true;
  let context = { task_id: "TASK", project_id: "P", source_revision: "REV", manifest_sha: "MANIFEST", base_sha: "BASE", review_commit_sha: null, state: "created", version: 1 };
  let current = { project_id: "P", status: "running", version: 1, details: { execution_id: "EXEC", execution_basis: BASIS, dependency_expectations: [] } };
  const events = [];
  const seen = new Set();
  const statusStore = { get: () => structuredClone(current),
    updateStatus: (_id, status, details, expected) => {
      assert.equal(current.version, expected.expectedVersion);
      assert.equal(current.details.execution_id, expected.expectedExecutionId);
      current = { ...current, status, details, version: current.version + 1 };
    },
    claimExecutionLaunch: (_id, input) => {
      input.validate();
      assert.equal(current.details.launch_claim, undefined);
      current.details.launch_claim = { ...input, validate: undefined };
      return { execution_id: input.executionId };
    },
    reconcileExecutionLaunch: () => { delete current.details.launch_claim; }
  };
  const registry = { get: () => ({ ...BASIS, status: ready ? "ready" : "blocked" }), assertReady: async () => {
    if (!ready) throw new Error("Plan no longer ready");
    return { sprint: BASIS, plan: { content: { tickets: ["TASK"], ticket_specs: [TICKET] } } };
  } };
  const workspace = { projectRoot: root, base_commit: "BASE", toolRegistry: Object.fromEntries(["write_diff", "commit_changes", "report_done"].map((name) => [name, { execute: async () => ({}) }])),
    executionContexts: { load: async () => structuredClone(context), create: async () => context, syncManifest: async () => structuredClone(context),
      update: async (_id, _version, patch) => { context = { ...context, ...patch, version: context.version + 1 }; } },
    changeLedger: { snapshot: async () => ({ revision: 0, entries: {}, commits: {} }), resume: async () => {}, release: async () => {} },
    testService: { assertPassedArtifact: async () => ({ artifact_id: "ARTIFACT", commit_sha: "COMMIT" }) },
    reportService: { assertCoderReport: async () => {}, completeCoderReport: async () => {} },
    integrate: async () => { integrations += 1; } };
  const occupancy = { getByTask: () => claim, claim: async () => { claim = { claim_id: "CLAIM", agent_id: "CODER", supervisor_id: "SUP-TASK" }; return claim; }, release: async () => { claim = null; } };
  const eventBus = { publish: async (event) => {
    if (event.event_id && seen.has(event.event_id)) return;
    if (event.event_id) seen.add(event.event_id);
    events.push(event);
    if (event.type === "task.completed") current.status = "done";
    if (event.type === "task.failed") current.status = "failed";
  } };
  let service;
  let integration;
  // Recreates all recovery callbacks, leaving only persisted files and simulated domain services shared.
  function restart(options = {}) {
    service?.stop();
    service = createCoderRecoveryRuntime({ store, checkpoints, ticketStatusStore: statusStore, sprintRegistry: registry,
      resolveTicketWorkspace: async () => workspace, eventBus, disposition: { get: async () => cancelled ? { disposition: "cancelled" } : null },
      agentOccupancy: occupancy, submitTicket: (input) => integration.submitTicket(input), clock: () => now,
      logger: { warn: () => {}, error: console.error }, ...options });
    integration = createNodeforgeTaskIntegration({ projectRoot: root, supervisorManager: { startTask: async () => ({}) },
      eventBus, ticketStatusStore: statusStore, sprintRegistry: registry, agentOccupancy: occupancy,
      agentResolver: { resolveAvailable: () => ({ agent_id: "CODER", role: "coder", provider: "codex" }) },
      handoffQueue: createDurableQueue({ name: "sender.handoff", store }), resolveTicketWorkspace: async () => workspace,
      checkpointStore: checkpoints, runtimeGovernance: { createExecutionContext: (input) => input }, coderRecovery: service,
      codexSdkGateway: { execute: async (input) => {
        invocations += 1;
        if (behavior) return behavior(input, invocations);
        throw sdkFailureEvidence(new ConfigurationError("Service rejected request"), { status: 503 });
      } } });
    return service;
  }
  restart();
  return { store, checkpoints, statusStore, events, restart, registry, workspace,
    get service() { return service; }, get invocations() { return invocations; }, get integrations() { return integrations; },
    advance: (delta) => { now += delta; }, staleSource: () => { context.source_revision = "NEW"; },
    cancelDisposition: () => { cancelled = true; }, revokePlan: () => { ready = false; },
    replaceExecution: () => { current.details.execution_id = "REPLACEMENT"; },
    run: () => service.runTicket({ ticket: TICKET, task_id: "TASK", project_id: "P", request_id: "REQ", correlation_id: "CORR",
      payload: { execution_id: "EXEC", sprint_basis: BASIS, dependency_expectations: [] } }),
    close: async () => { service.stop(); await rm(root, { recursive: true, force: true }); } };
}

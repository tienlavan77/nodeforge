import { ConfigurationError } from "../../shared/errors.js";
import { createDurableQueue } from "./durable-queue.js";
import { createExecutionEventBus } from "./execution-event-bus.js";
import { createSupervisorManager } from "./supervisor-manager.js";
import { createNodeforgeTaskIntegration } from "./nodeforge-task-integration.js";
import { createFileQueueStore } from "./file-queue-store.js";
import { createSupervisorStateStore } from "./supervisor-state-store.js";
import { createAgentRegistry } from "./agent-registry.js";
import { createSenderWorker } from "./sender-worker.js";
import { createProcessedRequestStore } from "./processed-request-store.js";
import { createProductionRepairWorker } from "./repair-worker-production.js";
import { createMaterializerWorker } from "./materializer-worker.js";
import { createVerificationWorker } from "./verification-worker.js";
import { createSupervisorLoop } from "./supervisor-loop.js";
import { createWorkerSignalBus } from "./worker-signal-bus.js";
import { createWorkerResultBus } from "./worker-result-bus.js";
import { createWorkerStatusBus } from "./worker-status-bus.js";
import { createForgeToolRegistry } from "../../tools/index.js";
import { createRuntimeToolGovernance } from "../governance/runtime-tool-governance.js";

const QUEUE_NAMES = ["agent.request", "materializer.request", "verification.request", "repair.request"];

export function createProductionSupervisorRuntime({ fileService, root = ".forge/runtime", eventStore, agentGateway, logger = console, projectLogger = () => {}, preparation = {}, roundControllerFactory, conversationStateStore, protocolStorage, autoStartWorkers = true, toolGovernance, governanceDatabase, codeSearch, enableReadCode = false } = {}) {
  const hasPreparation = Object.keys(preparation ?? {}).length > 0;
  const queueStore = createFileQueueStore({ fileService, root: `${root}/queues` });
  const stateStore = createSupervisorStateStore({ fileService, root: `${root}/supervisors` });
  const eventBus = createExecutionEventBus({ eventStore, validate: validateEvent });
  const signalBus = createWorkerSignalBus();
  const resultBus = createWorkerResultBus();
  const statusBus = createWorkerStatusBus();
  const queues = Object.fromEntries(QUEUE_NAMES.map((name) => [name, createSignaledQueue(createDurableQueue({ name, store: queueStore }), signalBus, name)]));
  const loops = new Map();
  const startingTasks = new Map();
  const controlLock = createProcessMutex();
  const processedRequestStore = createProcessedRequestStore({ fileService, root: `${root}/processed-requests` });
  const runtimeGovernance = toolGovernance ?? createRuntimeToolGovernance({ database: governanceDatabase, eventStore });
  const toolRegistry = protocolStorage?.get && fileService?.readForIndex ? createForgeToolRegistry({ protocolStorage, fileService, codeSearch, enableReadCode, governance: runtimeGovernance }) : {};
  const supervisorManager = createSupervisorManager({ eventBus, stateStore, preparation, onCreate: (runtime) => {
    const executionContextProvider = createExecutionContextProvider(runtime, runtimeGovernance, toolRegistry);
    const loop = createSupervisorLoop({ runtime, senderQueue: queues["agent.request"], materializerQueue: queues["materializer.request"], verificationQueue: queues["verification.request"], repairQueue: queues["repair.request"], eventBus, requestStore: processedRequestStore, roundController: typeof roundControllerFactory === "function" ? roundControllerFactory(runtime, { conversationStateStore, protocolStorage, toolRegistry, governance: runtimeGovernance, executionContextProvider }) : undefined });
    loops.set(runtime.supervisorId, loop);
    // Keep event handling off the publish call stack so control operations can
    // safely publish their own state events without re-entrant lock deadlocks.
    eventBus.subscribe(runtime.supervisorId, (event) => {
      logger.debug?.("Supervisor event routed", { task_id: runtime.taskId, supervisor_id: runtime.supervisorId, event_type: event?.type, request_id: event?.request_id });
      if (event?.type === "supervisor.state_changed" || event?.type === "task.started") return undefined;
      queueMicrotask(() => {
        void controlLock.run(runtime.taskId, () => loop.onEvent(event)).catch((error) => {
          logger.error?.("Supervisor event handling failed", { task_id: runtime.taskId, supervisor_id: runtime.supervisorId, event_type: event?.type, request_id: event?.request_id, error: error?.message });
        });
      });
    });
  } });
  const baseIntegration = createNodeforgeTaskIntegration({ supervisorManager, eventBus });
  const integration = { startTask: async (request) => {
    if (!request?.task_id) throw new ConfigurationError("Production task requires task_id.");
    if (startingTasks.has(request.task_id)) {
      const result = await startingTasks.get(request.task_id);
      return { ...result, status: "already_running" };
    }
    const startup = controlLock.run(request.task_id, () => startTaskExclusive(request));
    startingTasks.set(request.task_id, startup);
    try { return await startup; } finally { startingTasks.delete(request.task_id); }
  }};
  async function startTaskExclusive(request) {
    const result = await baseIntegration.startTask(request);
    // An active task already owns a running loop. Repeated Run clicks must
    // reuse that Supervisor instead of resetting its round controller.
    if (result.status === "already_running") return result;
    const loop = loops.get(result.supervisor_id);
    if (request.restart) await loop?.reset?.();
    const persisted = await stateStore.get(result.supervisor_id);
    // State snapshots keep compact metadata; retain the original request payload on resume.
    const pending = persisted?.pending_request ? { ...persisted.pending_request, ...request, attempt: Math.max(Number(persisted.pending_request.attempt) || 1, Number(request.attempt) || 1) } : request;
    const owner = supervisorManager.getByTask(result.task_id);
    if (hasPreparation && owner?.prepare) await owner.prepare(pending);
    if (loop && ["CREATED", "REQUESTING", "WAITING_AGENT", "READY"].includes((await stateStore.get(result.supervisor_id))?.state ?? "CREATED")) {
      await loop.start({ ...pending, task_id: result.task_id, supervisor_id: result.supervisor_id,
        request_id: pending.request_id ?? request.request_id, correlation_id: pending.correlation_id ?? request.correlation_id,
        attempt: pending.attempt ?? request.attempt ?? 1 }, { resume: result.status === "already_running" });
    }
    return result;
  }
  const agentRegistry = createAgentRegistry();
  if (agentGateway?.request) agentRegistry.register("builder", { send: (input) => agentGateway.request(input) });
  const senderWorker = createSenderWorker({ queue: queues["agent.request"], agentRegistry, eventBus, processedStore: processedRequestStore, statusBus, signalBus, projectLogger, protocolStorage, conversationStateStore, toolRegistry, runtimeGovernance });
  const materializerWorker = createMaterializerWorker({ fileService });
  const verificationWorker = createVerificationWorker();
  const materializerWorkerLoop = createQueuePoller(queues["materializer.request"], "materializer-1", signalBus, async (job) => { projectLogger({ event_name: "materializer.request_started", level: "info", status: "info", message: "Materializer Worker started job.", task_id: job.task_id, correlation_id: job.correlation_id, source: "materializer-worker", payload: { request_id: job.request_id, job_id: job.id } }); const result = await materializerWorker.verify({ ...job, ...(job.payload ?? {}) }); await eventBus.publish({ type: result.status === "valid" ? "material_verification.completed" : "material_verification.invalid", task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload: result }); projectLogger({ event_name: "material_worker.verification_completed", level: "info", status: result.status === "valid" ? "success" : "failed", message: "Material Worker completed verification.", task_id: job.task_id, correlation_id: job.correlation_id, source: "material-worker", payload: { request_id: job.request_id, job_id: job.id, status: result.status, valid: result.valid, invalid: result.invalid, invalid_count: result.invalid_count, repair_context: result.repair_context } }); await queues["materializer.request"].ack(job.id); });
  const verificationWorkerLoop = createQueuePoller(queues["verification.request"], "verification-1", signalBus, async (job) => { projectLogger({ event_name: "verification.request_started", level: "info", status: "info", message: "Verification Worker started job.", task_id: job.task_id, correlation_id: job.correlation_id, source: "verification-worker", payload: { request_id: job.request_id, job_id: job.id } }); const result = await verificationWorker.verifyPatches(job.payload ?? job); await eventBus.publish({ type: result.status === "passed" ? "verification.passed" : "verification.failed", task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload: result }); projectLogger({ event_name: "verification.request_completed", level: "info", status: result.status === "passed" ? "success" : "failed", message: "Verification Worker completed job.", task_id: job.task_id, correlation_id: job.correlation_id, source: "verification-worker", payload: { request_id: job.request_id, job_id: job.id, status: result.status } }); await queues["verification.request"].ack(job.id); });
  const repairWorker = createProductionRepairWorker({ queue: queues["repair.request"], senderQueue: queues["agent.request"], statusBus, signalBus, projectLogger });
  async function startWorkers() {
    senderWorker.start(); repairWorker.start(); materializerWorkerLoop.start(); verificationWorkerLoop.start();
    for (const name of QUEUE_NAMES) for (const job of await queueStore.list(name)) {
      if (["queued", "leased"].includes(job.status)) signalBus.wakeup({ source: "startup-recovery", target: name, queue: name, job_id: job.id, task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1 });
    }
  }
  if (autoStartWorkers) void startWorkers();
  async function supervisorRuntimePrepare(runtime, pending) { const owner = supervisorManager.getByTask(pending.task_id); if (owner?.prepare) await owner.prepare(pending); }
  return Object.freeze({ governance: runtimeGovernance, queues, queueStore, stateStore, processedRequestStore, eventBus, signalBus, resultBus, statusBus, supervisorManager, integration, agentRegistry, senderWorker, repairWorker, materializerWorkerLoop, verificationWorkerLoop, startWorkers, recover });

  async function recover() {
    logger.debug?.("Supervisor recovery: queue scan started");
    const recoveredQueues = {};
    for (const name of QUEUE_NAMES) recoveredQueues[name] = (await queues[name].recover()).length;
    const supervisors = await supervisorManager.recover();
    logger.debug?.("Supervisor recovery: manager loaded", { supervisors });
    for (const state of await stateStore.list({ scope: "pending" })) {
      const owner = supervisorManager.getByTask(state.task_id);
      if (!owner || owner.supervisorId !== state.supervisor_id) continue;
      const loop = loops.get(state.supervisor_id);
      const pending = state.pending_request;
      if (loop && pending?.payload && ["CREATED", "REQUESTING", "WAITING_AGENT"].includes(state.state)) {
        await controlLock.run(state.task_id, () => loop.start({ ...pending, task_id: state.task_id, supervisor_id: state.supervisor_id, request_id: pending.request_id, correlation_id: pending.correlation_id, attempt: pending.attempt ?? 1 }, { resume: true }));
      }
    }
    logger.debug?.("Supervisor recovery: pending loops resumed");
    logger.info?.("Supervisor production runtime recovered", { supervisors, queues: recoveredQueues });
    return { supervisors, queues: recoveredQueues };
  }
}

function createExecutionContextProvider(runtime, governance) {
  return ({ source = {}, round = 1, type } = {}) => {
    const existing = source.execution_context ?? source.executionContext;
    if (existing) return governance.createExecutionContext({ ...existing, lifecycle: runtime.getState?.() ?? "RUNNING" });
    return governance.createExecutionContext({
      task_id: runtime.taskId,
      execution_id: `${runtime.supervisorId}:${source.attempt ?? 1}`,
      agent_identity: { agent_id: source.agent_id ?? "builder", role: "builder" },
      capabilities: capabilitiesForRound(round, type),
      allowed_resources: { allowed_file_paths: source.allowed_file_paths ?? [], allowed_prefixes: source.allowed_prefixes ?? [] },
      lifecycle: runtime.getState?.() ?? "RUNNING",
      audit_context: { supervisor_id: runtime.supervisorId, correlation_id: source.correlation_id }
    });
  };
}

function capabilitiesForRound(round, type) {
  if (round === 1) return type === "task" ? [] : ["select_code_graph_candidates"];
  if (round === 2) return ["select_code_graph_candidates", "search_code", "read_code", "read_transcript_blocks"];
  if (round === 3) return ["read_transcript_blocks", "read_code"];
  return ["read_transcript_blocks", "read_code"];
}
function validateEvent(event) {
  return Boolean(event && typeof event.task_id === "string" && typeof event.supervisor_id === "string" && typeof event.request_id === "string" && typeof event.correlation_id === "string" && Number.isInteger(event.attempt) && event.attempt > 0 && typeof event.timestamp === "string" && event.payload && typeof event.payload === "object");
}

function createQueuePoller(queue, workerId, signalBus, handler) { let active = false; let unsubscribe; let running = false; const processOnce = async () => { if (running) return; running = true; try { const job = await queue.claim(workerId); if (job) await handler(job); } finally { running = false; } }; return { start() { if (active) return; active = true; unsubscribe = signalBus?.onWakeup?.((message) => { if (message.queue === queueName(queue)) void processOnce(); }); void processOnce(); }, stop() { unsubscribe?.(); unsubscribe = undefined; active = false; } }; }
function queueName(queue) { return queue.name ?? ""; }

function createProcessMutex() {
  const tails = new Map();
  return { run(key, operation) {
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(operation);
    tails.set(key, current);
    return current.finally(() => { if (tails.get(key) === current) tails.delete(key); });
  } };
}

function createSignaledQueue(queue, signalBus, queueName) { return Object.freeze({ ...queue, name: queueName, enqueue: async (job) => { const result = await queue.enqueue(job); signalBus.wakeup({ source: "queue-enqueue", target: queueName, queue: queueName, job_id: result.id, task_id: result.task_id, supervisor_id: result.supervisor_id, request_id: result.request_id, correlation_id: result.correlation_id, attempt: result.attempt ?? 1 }); return result; } }); }

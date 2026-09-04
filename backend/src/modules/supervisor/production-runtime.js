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

const QUEUE_NAMES = ["agent.request", "materializer.request", "verification.request", "repair.request"];

export function createProductionSupervisorRuntime({ fileService, root = ".forge/runtime", eventStore, agentGateway, logger = console, preparation = {}, roundControllerFactory, conversationStateStore, protocolStorage } = {}) {
  const hasPreparation = Object.keys(preparation ?? {}).length > 0;
  const queueStore = createFileQueueStore({ fileService, root: `${root}/queues` });
  const stateStore = createSupervisorStateStore({ fileService, root: `${root}/supervisors` });
  const eventBus = createExecutionEventBus({ eventStore, validate: validateEvent });
  const queues = Object.fromEntries(QUEUE_NAMES.map((name) => [name, createDurableQueue({ name, store: queueStore })]));
  const loops = new Map();
  const supervisorManager = createSupervisorManager({ eventBus, stateStore, preparation, onCreate: (runtime) => {
    const loop = createSupervisorLoop({ runtime, senderQueue: queues["agent.request"], materializerQueue: queues["materializer.request"], verificationQueue: queues["verification.request"], repairQueue: queues["repair.request"], eventBus, roundController: typeof roundControllerFactory === "function" ? roundControllerFactory(runtime, { conversationStateStore, protocolStorage }) : undefined });
    loops.set(runtime.supervisorId, loop); eventBus.subscribe(runtime.supervisorId, loop.onEvent);
  } });
  const baseIntegration = createNodeforgeTaskIntegration({ supervisorManager, eventBus });
  const integration = { startTask: async (request) => {
    const result = await baseIntegration.startTask(request);
    const loop = loops.get(result.supervisor_id);
    const persisted = await stateStore.get(result.supervisor_id);
    const pending = persisted?.pending_request ?? request;
    const owner = supervisorManager.getByTask(result.task_id);
    if (hasPreparation && owner?.prepare) await owner.prepare(pending);
    if (loop && ["CREATED", "WAITING_AGENT", "READY"].includes((await stateStore.get(result.supervisor_id))?.state ?? "CREATED")) {
      await loop.start({ ...pending, task_id: result.task_id, supervisor_id: result.supervisor_id,
        request_id: pending.request_id ?? request.request_id, correlation_id: pending.correlation_id ?? request.correlation_id,
        attempt: pending.attempt ?? request.attempt ?? 1 });
    }
    return result;
  }};
  const agentRegistry = createAgentRegistry();
  const processedRequestStore = createProcessedRequestStore({ fileService, root: `${root}/processed-requests` });
  if (agentGateway?.request) agentRegistry.register("builder", { send: (input) => agentGateway.request(input) });
  const senderWorker = createSenderWorker({ queue: queues["agent.request"], agentRegistry, eventBus, processedStore: processedRequestStore, protocolStorage, conversationStateStore });
  senderWorker.start();
  const materializerWorker = createMaterializerWorker({ fileService });
  const verificationWorker = createVerificationWorker();
  const materializerWorkerLoop = createQueuePoller(queues["materializer.request"], "materializer-1", async (job) => { const result = await materializerWorker.materialize({ ...job, ...(job.payload ?? {}) }); await eventBus.publish({ type: result.invalid_patches.length ? "materialization.invalid" : "materialization.completed", task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload: result }); await queues["materializer.request"].ack(job.id); });
  const verificationWorkerLoop = createQueuePoller(queues["verification.request"], "verification-1", async (job) => { const result = await verificationWorker.verifyPatches(job.payload ?? job); await eventBus.publish({ type: result.status === "passed" ? "verification.passed" : "verification.failed", task_id: job.task_id, supervisor_id: job.supervisor_id, request_id: job.request_id, correlation_id: job.correlation_id, attempt: job.attempt ?? 1, payload: result }); await queues["verification.request"].ack(job.id); });
  const repairWorker = createProductionRepairWorker({ queue: queues["repair.request"], senderQueue: queues["agent.request"] });
  repairWorker.start();
  materializerWorkerLoop.start(); verificationWorkerLoop.start();
  async function supervisorRuntimePrepare(runtime, pending) { const owner = supervisorManager.getByTask(pending.task_id); if (owner?.prepare) await owner.prepare(pending); }
  return Object.freeze({ queues, queueStore, stateStore, processedRequestStore, eventBus, supervisorManager, integration, agentRegistry, senderWorker, repairWorker, materializerWorkerLoop, verificationWorkerLoop, recover });

  async function recover() {
    const recoveredQueues = {};
    for (const name of QUEUE_NAMES) recoveredQueues[name] = (await queues[name].recover()).length;
    const supervisors = await supervisorManager.recover();
    for (const state of await stateStore.list()) {
      const loop = loops.get(state.supervisor_id);
      const pending = state.pending_request;
      if (loop && pending && ["CREATED", "WAITING_AGENT"].includes(state.state)) {
        await loop.start({ ...pending, task_id: state.task_id, supervisor_id: state.supervisor_id, request_id: pending.request_id, correlation_id: pending.correlation_id, attempt: pending.attempt ?? 1 }, { resume: true });
      }
    }
    logger.info?.("Supervisor production runtime recovered", { supervisors, queues: recoveredQueues });
    return { supervisors, queues: recoveredQueues };
  }
}

function validateEvent(event) {
  return Boolean(event && typeof event.task_id === "string" && typeof event.supervisor_id === "string" && typeof event.request_id === "string" && typeof event.correlation_id === "string" && Number.isInteger(event.attempt) && event.attempt > 0 && typeof event.timestamp === "string" && event.payload && typeof event.payload === "object");
}

function createQueuePoller(queue, workerId, handler) { let timer; return { start(intervalMs = 50) { if (!timer) { timer = setInterval(async () => { const job = await queue.claim(workerId); if (job) await handler(job); }, intervalMs); timer.unref?.(); } }, stop() { if (timer) clearInterval(timer); timer = undefined; } }; }

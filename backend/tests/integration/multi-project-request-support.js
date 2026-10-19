// Builds root-local application services for real HTTP multi-project routing witnesses.
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import { createControlApiStorage } from "../../scripts/control-api-storage.mjs";
import { createHumanPlanStore } from "../../src/modules/governance/human-plan-store.js";
import { createSprintRegistry } from "../../src/modules/governance/sprint-registry.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createConversationCrudService } from "../../src/application/conversation-crud-service.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createDirectCodeRequest } from "../../src/application/direct-code-request.js";
import { createGitService } from "../../src/infrastructure/git/git-service.js";

// Uses production storage and application factories, isolating only external agent execution.
export async function createRoutingApplication({ config, storage }) {
  execFileSync("git", ["init", "-q"], { cwd: config.cwd });
  const projectId = config.projectId;
  const database = storage.controlDb;
  const fileService = storage.fileService;
  const planFileService = createFileService({ projectRoot: config.cwd, allowPlanStorage: true });
  const planStore = createHumanPlanStore({ projectId, database, fileService: planFileService });
  const sprintRegistry = createSprintRegistry({ projectId, database, plans: planStore });
  const conversations = createConversationCrudService({ database });
  const communications = createAgentCommunicationStore({ database, fileService });
  const bus = createAgentCommunicationBus({ store: communications });
  const taskId = `CODE-${projectId}`;
  await fileService.atomicWrite({ path: `.forge/runtime/nf/code-requests/${taskId}.json`, content: JSON.stringify({ task_id: taskId, project_id: projectId, mode: "direct_code" }) });
  const directCodeRequest = createDirectCodeRequest({ fileService, projectId,
    integration: { submitTicket: async () => { throw new Error("Unapproved dispatch must not run"); } },
    checkpoints: { load: async () => null, listPending: async () => [{ task_id: taskId }] }
  });
  const services = {
    projectId, projectRoot: config.cwd, fileService, planFileService, planStore, sprintRegistry,
    conversations, communications, bus, internalBus: new EventEmitter(), indexDb: storage.indexDb,
    conversationStateStore: storage.conversationStateStore, protocolStorage: storage.protocolStorage,
    gitService: createGitService({ projectRoot: config.cwd }), directCodeRequest,
    agentConfiguration: { getById: () => null }, agentGateway: { stream: async function* () {} },
    sprintOrchestration: { run: async () => { throw new Error("Unapproved sprint must not run"); }, ingestAgentCompletion: () => {} },
    logEvent: () => {}, publishUnifiedStreamEvent: () => {}
  };
  return { services, storage, workers: [] };
}

// Acquires production storage without changing the global project's logging configuration.
export function createRoutingStorage(input) { return createControlApiStorage({ ...input, configureLogs: false }); }

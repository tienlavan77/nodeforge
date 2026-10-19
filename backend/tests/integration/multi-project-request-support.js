// Builds root-local application services for real HTTP multi-project routing witnesses.
import { EventEmitter } from "node:events";
import assert from "node:assert/strict";
import { join } from "node:path";
import { SPRINT } from "../fixtures/sprint-registry-migration-fixture.mjs";
import { createArchitectureDecisionStore } from "../../src/modules/governance/architecture-decision-store.js";
import { createHumanDecisionService } from "../../src/application/human-decision-service.js";
import { createArchitectureWorkspaceService } from "../../src/application/architecture-workspace-service.js";
import { createProjectDashboardService } from "../../src/application/project-dashboard-service.js";
import { createConversationAuditHistoryService } from "../../src/application/conversation-audit-history-service.js";
import { createTaskStore } from "../../src/modules/projects/task-store.js";
import { createTaskSessionPreparation, createSessionStore } from "../../src/modules/projects/session-store.js";
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
import { createSubscriptionRegistry } from "../../src/modules/events/subscription-registry.js";

// Uses production storage and application factories, isolating only external agent execution.
export async function createRoutingApplication({ config, storage }) {
  execFileSync("git", ["init", "-q"], { cwd: config.cwd });
  const projectId = config.projectId;
  execFileSync("git", ["symbolic-ref", "HEAD", `refs/heads/${projectId}`], { cwd: config.cwd });
  const database = storage.controlDb;
  const fileService = storage.fileService;
  const planFileService = createFileService({ projectRoot: config.cwd, allowPlanStorage: true });
  const planStore = createHumanPlanStore({ projectId, database, fileService: planFileService });
  const sprintRegistry = createSprintRegistry({ projectId, database, plans: planStore });
  const conversations = createConversationCrudService({ database });
  const communications = createAgentCommunicationStore({ database, fileService });
  const bus = createAgentCommunicationBus({ store: communications });
  const decisions = createArchitectureDecisionStore({ database });
  const architectureWorkspaceService = createArchitectureWorkspaceService({ knowledge: {
    getArchitecture: () => [{ project_id: projectId, title: `Architecture for ${projectId}` }],
    getStandards: () => [], getConstraints: () => [], getDecisions: decisions.getAll
  } });
  const projectDashboardService = createProjectDashboardService({ sprintRegistry,
    roadmaps: { getCurrent: () => null },
    sprintPlans: { getCurrentSprint: () => null, getSprintStatus: () => null, getSprintBacklog: () => [] }
  });
  const taskId = `CODE-${projectId}`;
  try {
    await fileService.readFile({ path: `.forge/runtime/nf/code-requests/${taskId}.json` });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await fileService.atomicCreate({ path: `.forge/runtime/nf/code-requests/${taskId}.json`, content: JSON.stringify({ task_id: taskId, project_id: projectId, mode: "direct_code" }) });
  }
  const directCodeRequest = createDirectCodeRequest({ fileService, projectId,
    integration: { submitTicket: async () => { throw new Error("Unapproved dispatch must not run"); } },
    checkpoints: { load: async () => null, listPending: async () => [{ task_id: taskId }] }
  });
  const services = {
    projectId, projectRoot: config.cwd, fileService, planFileService, planStore, sprintRegistry,
    decisions, architectureWorkspaceService, projectDashboardService,
    humanDecisionService: createHumanDecisionService({ decisions, bus }),
    conversationAuditHistoryService: createConversationAuditHistoryService({ communications }),
    prepareTaskSession: createTaskSessionPreparation({ projectId, fileService, taskStore: createTaskStore({ projectId, database }) }),
    sessions: createSessionStore({ projectId, fileService }),
    conversations, communications, bus, subscriptions: createSubscriptionRegistry(), internalBus: new EventEmitter(), indexDb: storage.indexDb,
    conversationStateStore: storage.conversationStateStore, protocolStorage: storage.protocolStorage,
    gitService: createGitService({ projectRoot: config.cwd }), directCodeRequest,
    agentConfiguration: { getById: () => null }, agentGateway: { stream: async function* () {} },
    sprintOrchestration: { run: async () => { throw new Error("Unapproved sprint must not run"); }, ingestAgentCompletion: () => {} },
    logEvent: () => {}, publishUnifiedStreamEvent: () => {}
  };
  return { services, storage, workers: [] };
}

// Exercises existing legacy URLs against isolated stores and rejects unadmitted or contradictory contexts.
export async function verifyLegacyProjectRequests(f) {
  const bundles = await Promise.all(["PROJECT-A", "PROJECT-B"].map(f.applications.resolve));
  // Sends legacy requests without changing their path, query, or JSON payload conventions.
  async function legacy(projectId, endpoint, { query = "", body, status = 200 } = {}) {
    const response = await fetch(new URL(`/projects/${projectId}/${endpoint}${query}`, f.origin), {
      method: endpoint === "decisions" ? "POST" : "GET",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  for (const services of bundles) {
    const projectId = services.projectId;
    const proposalId = `PROPOSAL-${projectId}`;
    services.decisions.append({ id: proposalId, project_id: projectId, type: "architecture", title: "Root-local proposal",
      decision: "Keep project services isolated", status: "proposed", created_at: "2026-08-21T15:00:00Z" });
    const body = { decision_id: `HUMAN-${projectId}`, type: "human_governance", actor: "OWNER", actor_role: "project_owner",
      proposal_id: proposalId, decision: "APPROVE", correlation_id: `CORR-${projectId}`, timestamp: "2026-08-21T15:01:00Z" };
    const decision = await legacy(projectId, "decisions", { body, status: 201 });
    assert.equal(decision.decision.project_id, projectId);
    assert.equal(services.decisions.load().find((item) => item.decision_id === body.decision_id).proposal_id, proposalId);
    const other = bundles.find((item) => item !== services);
    assert.equal(other.decisions.getById(body.decision_id), undefined);
    assert.equal(other.communications.getById(`MSG-HUMAN-DECISION-${body.decision_id}`), undefined);
    const workspace = await legacy(projectId, "architecture-workspace");
    assert.deepEqual(workspace, services.architectureWorkspaceService.getWorkspace(projectId));
    assert.equal(workspace.architecture_plan.architecture[0].title, `Architecture for ${projectId}`);
    const sprint = JSON.parse(JSON.stringify(SPRINT).replaceAll("PROJECT-NODEFORGE", projectId));
    await f.request("sprints", { method: "POST", status: 201, body: { project_id: projectId, sprint_plan: sprint } });
    const dashboard = await legacy(projectId, "dashboard");
    const expected = await services.projectDashboardService.getDashboard(projectId);
    assert.equal(dashboard.project_id, projectId);
    assert.ok(expected.sprints.length > 0);
    assert.deepEqual(dashboard.sprints, expected.sprints);
    const history = await legacy(projectId, "history", { query: `?correlationId=CORR-${projectId}&order=desc&limit=1` });
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].id, `MSG-HUMAN-DECISION-${body.decision_id}`);
    await legacy(projectId, "decisions", { body: { ...body, project_id: other.projectId }, status: 409 });
    await legacy(projectId, "decisions", { body: { ...body, project: other.projectId }, status: 409 });
  }
  for (const endpoint of ["decisions", "architecture-workspace", "dashboard", "history"]) {
    const body = endpoint === "decisions" ? {} : undefined;
    await legacy("UNKNOWN", endpoint, { body, status: 404 });
    await legacy("PROJECT-A", endpoint, { body, query: "?project=PROJECT-B", status: 409 });
  }
  await f.disposal.releaseRuntime(f.runtimes.get(join(f.base, "PROJECT-A")));
  for (const endpoint of ["decisions", "architecture-workspace", "dashboard", "history"]) {
    await legacy("PROJECT-A", endpoint, { body: endpoint === "decisions" ? {} : undefined, status: 404 });
  }
  assert.equal(bundles[1].decisions.load().filter((item) => item.type === "human_governance").length, 1);
}

// Acquires production storage without changing the global project's logging configuration.
export function createRoutingStorage(input) { return createControlApiStorage({ ...input, configureLogs: false }); }

// nodeforge task integration - provides nodeforge task integration functionality for NodeForge.
import { ConfigurationError } from "../../shared/errors.js";
import { createAgentExecutionCheckpointStore } from "../agent/agent-execution-checkpoint.js";
import { createNodeforgeTaskExecutors } from "./nodeforge-task-executors.js";
export { ticketCandidateScope } from "./nodeforge-task-scope.js";

// createNodeforgeTaskIntegration - handles createNodeforgeTaskIntegration operation.
export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, handoffQueue, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {}, fileService, checkpointStore, relevantTreeSelector, protocolStorage } = {}) {
  if (typeof supervisorManager?.startTask !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("NodeForge integration requires Supervisor Manager and Event Bus.");
  if (typeof handoffQueue?.enqueue !== "function") throw new ConfigurationError("NodeForge integration requires a sender handoff queue.");
  const checkpoints = checkpointStore ?? (fileService ? createAgentExecutionCheckpointStore({ fileService }) : null);
  const publishedOwners = new Set();
  const executors = createNodeforgeTaskExecutors({
    claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry,
    runtimeGovernance, projectRoot, projectLogger, checkpoints, relevantTreeSelector,
    protocolStorage
  });
  return Object.freeze({ startTask, submitTicket });

  async function submitTicket({ ticket, task_id, project_id, request_id, correlation_id, attempt = 1, payload = {}, required_role } = {}) {
    if (!ticket || typeof ticket !== "object") throw new ConfigurationError("Node Supervisor ticket is required.");
    if (typeof agentResolver?.resolveAvailable !== "function") throw new ConfigurationError("NodeForge integration requires an agent resolver.");
    const selected = agentResolver.resolveAvailable(required_role ?? ticket.required_role);
    if (!selected) throw Object.assign(new ConfigurationError("No enabled and ready Agent Profile is available."), { code: "AGENT_NOT_AVAILABLE" });
    const request = {
      task_id: task_id ?? ticket.id,
      project_id: project_id ?? ticket.project_id,
      request_id: request_id ?? `REQ-${task_id ?? ticket.id}`,
      correlation_id: correlation_id ?? `CORR-${task_id ?? ticket.id}`,
      attempt,
      agent_id: selected.agent_id,
      selected_agent_id: selected.agent_id,
      selected_agent_name: selected.agent_name,
      selected_agent_role: selected.role,
      required_role: required_role ?? ticket.required_role,
      ticket,
      payload
    };
    const queued = await handoffQueue.enqueue(request);
    projectLogger({ event_name: "supervisor.ticket_handoff", level: "info", status: "success", message: "Supervisor selected agent and queued handoff.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, job_id: queued?.id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role } });
    let result;
    try {
      projectLogger({ event_name: "supervisor.agent_execution_started", level: "info", status: "started", message: "Supervisor started Agent execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null } });
      result = isOpenAiProfile(selected)
        ? await executors.runOpenAiHello(selected, request)
        : isCodexProfile(selected)
          ? await executors.runCodexTask(selected, request)
        : isOllamaProfile(selected)
          ? await executors.runOllamaHello(selected, request)
        : await executors.runToolTicket(selected, request);
    } catch (error) {
      projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Ticket execution failed.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, ...(error.tool ? { tool: error.tool } : {}), error: error.message } });
      throw error;
    }
    projectLogger({ event_name: "supervisor.agent_execution_completed", level: "info", status: "success", message: "Agent completed execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null, tool_events: result.tool_events } });
    return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status: "completed", job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
  }

  async function startTask({ task_id, project_id, request_id, correlation_id, attempt = 1, request = {}, payload, ticket, relevantTree = [], restart = false } = {}) {
    const runtime = await supervisorManager.startTask({ task_id, project_id, request_id, correlation_id, attempt, payload, ticket, relevantTree, restart });
    if (runtime.ownershipCreated && !publishedOwners.has(runtime.supervisorId)) {
      publishedOwners.add(runtime.supervisorId);
      await eventBus.publish({ type: "task.started", task_id, supervisor_id: runtime.supervisorId, request_id: request_id ?? `REQ-${task_id}`, correlation_id: correlation_id ?? `CORR-${task_id}`, attempt, payload: { project_id, request, relevantTree, ticket, ...(payload ? { payload } : {}) } });
    }
    return { task_id, supervisor_id: runtime.supervisorId, status: runtime.ownershipCreated || restart || runtime.wasReset ? "started" : "already_running" };
  }
}

// Selects profiles that use the OpenAI SDK greeting flow.
function isOpenAiProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "openai";
}

// Selects profiles that use the Codex SDK implementation flow.
function isCodexProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "codex";
}

// Selects profiles that use the Ollama SDK greeting flow.
function isOllamaProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "ollama";
}

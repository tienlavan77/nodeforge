// Executes compatible-provider Coder tickets with the same scoped engineering
// tools, checkpoint journal and completion gates used by other Coder transports.
// Model history stays in memory between phase yields; process recovery rebuilds
// the prompt from durable tool checkpoints rather than replaying old mutations.
import { ConfigurationError } from "../../shared/errors.js";
import { classifyTicketComplexity } from "../../tools/ticket-complexity.js";
import { CODER_TOOL_NAMES, coderToolDefinitions } from "../../tools/engineering-tool-catalog.js";
import { bindEngineeringTools } from "../../tools/engineering-tool-binding.js";
import { isProtectedPath } from "../../infrastructure/filesystem/protected-path-policy.js";
import { ticketAllowedPrefixes } from "./nodeforge-task-scope.js";
import { buildCodexTicketPrompt } from "./nodeforge-task-prompts.js";
import { buildResumePrompt, checkpointedRegistry, createResumeState, failureDetail } from "./ticket-resume.js";
import { saveProgressCheckpoint } from "./ticket-checkpoint-writer.js";
import { runTicketSdkTurns } from "./ticket-sdk-turns.js";
import { sdkToolEvent } from "./nodeforge-task-sdk-events.js";
import { coderFailureTriage } from "./coder-recovery-policy.js";
import { withCoderExchange, coderExchangePrompt } from "./coder-agent-exchange.js";

// Creates a ticket-bound executor without exposing shell tools or selecting a
// replacement provider. Missing gateways fail before any governed tool call.
export function createFunctionCallingTaskExecutor({ openaiSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance,
  projectRoot, projectLogger = () => {}, checkpoints }) {
  return withCoderExchange(execute, { projectRoot, projectLogger });

  // Keeps provider identity, source scope and tool receipts attached to the
  // original assignment across successful phase turns and explicit Resume.
  async function execute(selected, request) {
    if (selected.role !== "coder") throw new ConfigurationError("Function-calling ticket execution requires the Coder role.");
    const gateway = selected.provider === "ollama" ? ollamaSdkGateway : openaiSdkGateway;
    if (typeof gateway?.execute !== "function" || !toolRegistry || !runtimeGovernance?.createExecutionContext)
      throw new ConfigurationError("Compatible Coder execution requires its SDK gateway and governed Forge tools.");
    const ticket = { ...request.ticket, id: request.task_id };
    const resumeState = createResumeState(request.payload?.resume_from);
    resumeState.agentExchange = request.payload?.agent_exchange ?? resumeState.agentExchange;
    const priorCompletedTools = [...resumeState.completedTools];
    const manifestPaths = Object.keys(request.execution_context?.approved_baseline?.file_checksums ?? {}).sort();
    const immutableScope = manifestPaths.length > 0;
    const allowedPrefixes = immutableScope ? manifestPaths : [...new Set([...ticketAllowedPrefixes(ticket), "backend/", "ui/", "schemas/", "web/"])];
    const restoredPaths = request.payload?.resume_from && request.execution_context?.task_id === request.task_id
      ? (request.execution_context.manifest_paths ?? []).filter(path => typeof path === "string"
        && /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/.test(path)
        && !path.split("/").includes("node_modules") && !isProtectedPath(path, { operation: "write" })) : [];
    const allowedFilePaths = [...new Set([...(immutableScope ? manifestPaths : ["backend/package.json", ...restoredPaths]),
      "workflows/agents/coder/README.md", "workflows/agents/reviewer/README.md", "AGENTS.md", "CLAUDE.md", "package.json", "vocabulary/glossary.md"])];
    const complexity = classifyTicketComplexity(ticket);
    const context = runtimeGovernance.createExecutionContext({ task_id: request.task_id, execution_id: `${request.task_id}:${request.request_id}`,
      project_root: projectRoot, execution_context: request.execution_context, resume_checkpoint: Boolean(request.payload?.resume_from),
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider },
      capabilities: [...CODER_TOOL_NAMES], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes,
      changed_paths: [...resumeState.changedPaths], context_budget: { max_bytes: 1000000, max_calls: 12 },
      discovery_budget: complexity.discovery_budget, allow_discovery_escalation: true,
      lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id } });
    const toolContext = { ...context, project_id: request.project_id, project_root: projectRoot,
      execution_context: request.execution_context ?? null, ticket, task: ticket, task_context: ticket,
      changed_paths: [...resumeState.changedPaths], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes,
      abortSignal: request.abortSignal, session_id: context.execution_id };
    const registry = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id,
      allowedPrefixes, complexity, selected, correlationId: request.correlation_id, resumeState, projectLogger });
    const binding = bindEngineeringTools({ registry, context: toolContext });
    const definitions = coderToolDefinitions();
    const events = [];
    let history;
    const observed = Object.fromEntries(definitions.map(({ name }) => [name, { execute: async (args) => {
      let result;
      try { result = await binding.registry[name].execute(args); }
      catch (error) {
        record(name, args, undefined, error);
        throw error;
      }
      record(name, args, result);
      return result;
    } }]));
    try {
      const completed = await runTicketSdkTurns({ selected, request, resumeState, checkpoints, projectRoot, projectLogger,
        priorTools: priorCompletedTools, labMode: Boolean(request.payload?.tool_test),
        prompt: `${coderExchangePrompt(request)}\n\n${buildResumePrompt(buildCodexTicketPrompt(ticket, null, allowedPrefixes, complexity,
          request.payload?.direct_code === true, immutableScope), resumeState, { agentId: selected.agent_id, provider: selected.provider, changedPaths: toolContext.changed_paths })}`,
        readToolEvents: () => events.splice(0), executeTurn: async prompt => {
          request.abortSignal?.throwIfAborted();
          const result = await gateway.execute({ agent: selected, agentId: selected.agent_id, correlationId: request.correlation_id,
            cwd: projectRoot, abortSignal: request.abortSignal, prompt,
            options: { retainHistory: true, ...(history ? { history } : {}), forgeTools: { ...binding, registry: observed, definitions } } });
          history = result.history;
          return result;
        } });
      return { summary: completed.result.text || "<empty response>", tool_events: completed.toolEvents };
    } catch (error) {
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id,
        agent_id: selected.agent_id, provider: selected.provider, allowed_prefixes: allowedPrefixes,
        changed_paths: [...resumeState.changedPaths], status: "blocked", failure: failureDetail(error),
        ...(error.code === "CODER_BLOCKED" ? { triage: coderFailureTriage(error), failure_request_id: request.request_id } : {}) });
      throw error;
    }

    // Derives completion evidence from actual governed calls, never from model
    // claims. Existing normalization bounds output and retains native failures.
    function record(name, args, result, error) {
      const event = sdkToolEvent({ type: "item.completed", item: { type: "mcp_tool_call", server: "forge", tool: name,
        arguments: args, result, status: error ? "failed" : "completed",
        ...(error ? { error: { message: error.message, code: error.code, details: error.details } } : {}) } });
      events.push(event);
      projectLogger({ event_name: "supervisor.agent_tool_event", level: event.status === "failed" ? "error" : "info",
        status: event.status, message: `${selected.provider} Forge tool ${name} ${event.status}.`, task_id: request.task_id,
        correlation_id: request.correlation_id, source: "function-calling-ticket", payload: { agent_id: selected.agent_id, ...event } });
    }
  }
}

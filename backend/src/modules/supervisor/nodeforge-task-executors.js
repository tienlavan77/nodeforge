// Runs Claude, Codex, OpenAI, and Ollama SDK flows for governed ticket work.
import { ConfigurationError } from "../../shared/errors.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../tools/claude-sdk-forge-tools.js";
import { createClaudeForgeOptions } from "../../tools/claude-forge-options.js";
import { classifyTicketComplexity } from "../../tools/ticket-complexity.js";
import { selectCodeGraphCandidatesDefinition, searchCodeDefinition, readFileDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition, gitStatusDefinition, gitDiffDefinition } from "../../tools/index.js";
import { saveProgressCheckpoint } from "./ticket-checkpoint-writer.js";
import { buildResumePrompt, checkpointedRegistry, createResumeState, failureDetail } from "./ticket-resume.js";
import { isProtectedPath } from "../../infrastructure/filesystem/protected-path-policy.js";
import { ticketAllowedPrefixes } from "./nodeforge-task-scope.js";
import { COMPLEXITY_FALLBACK, buildCodexTicketPrompt, buildCodexToolTestPrompt, buildToolTicketPrompt, buildToolTestPrompt } from "./nodeforge-task-prompts.js";
import { assertTicketExecutionCompleted, collectToolCalls, extractFinalAgentReport, sdkToolEvent } from "./nodeforge-task-sdk-events.js";

// Creates SDK executors that keep Claude and Claude Code ticket policies aligned.
export function createNodeforgeTaskExecutors({ claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger, checkpoints }) {
  return Object.freeze({ runOpenAiHello, runOllamaHello, runToolTicket, runCodexTask });

  async function runToolTicket(selected, request) {
    if (typeof claudeSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Claude SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const directCode = request.payload?.direct_code === true;
    const candidateDiscoveryEnabled = selected.role !== "coder" && !directCode && !immutableScope;
    const manifestPaths = immutableManifestPaths(request.execution_context);
    const immutableScope = manifestPaths.length > 0;
    const targetPath = labMode?.target_path ?? null;
    const allowedPrefixes = immutableScope ? manifestPaths : [...new Set([...(labMode?.allowed_prefixes ?? []), ...ticketAllowedPrefixes(ticket), "backend/", "ui/", "schemas/", "web/"])];
    const allowedFilePaths = [...new Set([...(immutableScope ? manifestPaths : ["backend/package.json", ...resumeLedgerPaths(request)]), "workflows/agents/coder/README.md", "AGENTS.md", "package.json", "vocabulary/glossary.md"])];
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    if (!labMode && ticket.style?.includes("docs")) complexity.read_calls = Math.max(complexity.read_calls, 5);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, reasoning: complexity.reasoning } });
    const resumeState = createResumeState(request.payload?.resume_from ?? null);
    const priorCompletedTools = [...resumeState.completedTools];
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id, execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: [...(candidateDiscoveryEnabled ? ["select_code_graph_candidates"] : []), "search_code", "read_file", ...(selected.role === "coder" ? ["Read", "Glob", "Grep"] : []), "write_diff", "edit_diff", "run_test", "check_test", "git_status", "git_diff", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, changed_paths: [...resumeState.changedPaths],
      context_budget: { max_bytes: 1000000, max_calls: 12 }, discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls, discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls,
      allow_discovery_escalation: true,
      lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, project_root: projectRoot, execution_context: request.execution_context ?? null, ticket, task: ticket, task_context: ticket, changed_paths: [...resumeState.changedPaths], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id, resumeState, labMode: Boolean(labMode) });
    const mcpServers = { forge: createForgeSdkMcpServer({ registry: checkpointed, context: toolContext, includeCommit: true, includeClaudeFileTools: selected.role === "coder", excludeTools: ["respond_to_review", ...(candidateDiscoveryEnabled ? [] : ["select_code_graph_candidates"])] }) };
    let result;
    try {
      result = await claudeSdkGateway.execute({
        agentId: selected.agent_id, correlationId: request.correlation_id, cwd: projectRoot, abortSignal: request.abortSignal,
        options: createClaudeForgeOptions({ mcpServers, allowedTools: forgeSdkToolNames.filter((name) => name !== "mcp__forge__respond_to_review" && !((!candidateDiscoveryEnabled && name === "mcp__forge__select_code_graph_candidates") || (selected.role !== "coder" && ["mcp__forge__Read", "mcp__forge__Glob", "mcp__forge__Grep"].includes(name)))) }, { effort: complexity.effort, thinking: complexity.thinking }),
        resumeSessionId: resumeState.sessionId,
        onSessionReady: (sessionId) => { if (typeof sessionId === "string" && sessionId) resumeState.sessionId = sessionId; saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, execution_context: toolContext.execution_context }); },
        prompt: buildResumePrompt(labMode ? buildToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode, immutableScope), resumeState, { agentId: selected.agent_id, provider: selected.provider, changedPaths: toolContext.changed_paths })
      });
      const toolEvents = collectToolCalls(Array.isArray(result?.messages) ? result.messages : []);
      assertTicketExecutionCompleted(toolEvents, { labMode, missingCode: "CLAUDE_MCP_TOOL_CALLS_MISSING", priorTools: priorCompletedTools });
      return { summary: extractFinalAgentReport(result.messages) || "<empty response>", tool_events: toolEvents };
    } catch (error) {
      const failure = normalizeAgentFailure(error);
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id, agent_id: selected?.agent_id ?? null, provider: selected?.provider ?? null, target_path: targetPath, allowed_prefixes: allowedPrefixes, complexity_level: complexity?.level ?? null, changed_paths: [...resumeState.changedPaths], status: "blocked", failure: failureDetail(failure) });
      throw error;
    }
  }

  // Sends a short greeting through the configured OpenAI SDK.
  async function runOpenAiHello(selected, request) {
    if (typeof openaiSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires an OpenAI SDK gateway.");
    const result = await openaiSdkGateway.execute({ agent: selected, correlationId: request.correlation_id, prompt: "Say hello to the NodeForge Supervisor in one short sentence." });
    return { summary: result.text || "<empty response>", tool_events: [] };
  }

  // Sends a short greeting through the configured Ollama SDK.
  async function runOllamaHello(selected, request) {
    if (typeof ollamaSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires an Ollama SDK gateway.");
    const result = await ollamaSdkGateway.execute({ agent: selected, correlationId: request.correlation_id, prompt: "Say hello to the NodeForge Supervisor in one short sentence." });
    return { summary: result.text || "<empty response>", tool_events: [] };
  }

  // Runs a ticket through Claude Code with governed Forge tools.
  async function runCodexTask(selected, request) {
    if (typeof codexSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Codex SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const directCode = request.payload?.direct_code === true;
    const candidateDiscoveryEnabled = selected.role !== "coder" && !directCode && !immutableScope;
    const manifestPaths = immutableManifestPaths(request.execution_context);
    const immutableScope = manifestPaths.length > 0;
    const targetPath = labMode?.target_path ?? null;
    const allowedPrefixes = immutableScope ? manifestPaths : [...new Set([...(labMode?.allowed_prefixes ?? []), ...ticketAllowedPrefixes(ticket), "backend/", "ui/", "schemas/", "web/"])];
    const allowedFilePaths = [...new Set([...(immutableScope ? manifestPaths : ["backend/package.json", ...resumeLedgerPaths(request)]), "workflows/agents/coder/README.md", "AGENTS.md", "package.json", "vocabulary/glossary.md"])];
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    if (!labMode && ticket.style?.includes("docs")) complexity.read_calls = Math.max(complexity.read_calls, 5);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, reasoning: complexity.reasoning } });
    const resumeState = createResumeState(request.payload?.resume_from ?? null);
    const priorCompletedTools = [...resumeState.completedTools];
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id, execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: [...(candidateDiscoveryEnabled ? ["select_code_graph_candidates"] : []), "search_code", "read_file", "rg_files", "rg_search", "sed_lines", "write_diff", "edit_diff", "run_test", "check_test", "git_status", "git_diff", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, changed_paths: [...resumeState.changedPaths],
      context_budget: { max_bytes: 1000000, max_calls: 12 }, discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls, discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls,
      allow_discovery_escalation: true,
      lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, project_root: projectRoot, execution_context: request.execution_context ?? null, ticket, task: ticket, task_context: ticket, changed_paths: [...resumeState.changedPaths], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id, resumeState, labMode: Boolean(labMode) });
    const definitions = [...(candidateDiscoveryEnabled ? [selectCodeGraphCandidatesDefinition] : []), searchCodeDefinition, { ...readFileDefinition, description: "Read one file's cached metadata, symbol map and scoped graph without source; use sed_lines for code." , input_schema: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string", minLength: 1 } } } }, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, writeDiffDefinition, { ...editDiffDefinition, description: "Replace an exact anchor in one approved file after checksum validation. Use sed_lines to inspect source and find a unique anchor." }, runTestDefinition, checkTestDefinition, gitStatusDefinition, gitDiffDefinition, commitChangesDefinition, reportDoneDefinition];
    const forgeToolNames = new Set(definitions.map((definition) => definition.name));
    const codexToolEvents = [];
    let result;
    try {
      result = await codexSdkGateway.execute({
        agentId: selected.agent_id, correlationId: request.correlation_id, cwd: projectRoot, resumeThreadId: resumeState.threadId, abortSignal: request.abortSignal,
        onSessionReady: (threadId, toolNames) => {
          if (typeof threadId === "string" && threadId) resumeState.threadId = threadId;
          if (Array.isArray(toolNames)) projectLogger({ event_name: "supervisor.codex_mcp_session_ready", level: "info", status: "success", message: "Codex Forge MCP session ready.", task_id: request.task_id, correlation_id: request.correlation_id, source: "codex-sdk-ticket", payload: { request_id: request.request_id, agent_id: selected.agent_id, tools: toolNames } });
          saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, execution_context: toolContext.execution_context });
        },
        options: { model: selected.model, forgeTools: { registry: checkpointed, context: toolContext, definitions }, approvalPolicy: labMode?.approval_policy ?? "on-request" },
        prompt: buildResumePrompt(labMode ? buildCodexToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity, directCode, immutableScope), resumeState, { agentId: selected.agent_id, provider: selected.provider, changedPaths: toolContext.changed_paths }),
        onEvent: async (event) => {
          const toolEvent = sdkToolEvent(event, forgeToolNames);
          if (!toolEvent) return;
          codexToolEvents.push(toolEvent);
          projectLogger({ event_name: "supervisor.agent_tool_event", level: toolEvent.status === "failed" ? "error" : "info", status: toolEvent.status === "failed" ? "failed" : "success", message: `Codex Forge MCP tool ${toolEvent.tool} ${toolEvent.status}.`, task_id: request.task_id, ticket_id: request.task_id, correlation_id: request.correlation_id, source: labMode ? "codex-sdk-tool-lab" : "codex-sdk-ticket", payload: { request_id: request.request_id, agent_id: selected.agent_id, server: "forge", tool: toolEvent.tool, item_id: toolEvent.item_id, arguments: toolEvent.arguments, result: toolEvent.result, error: toolEvent.error } });
        }
      });
      if (codexToolEvents.length === 0) throw Object.assign(new ConfigurationError("Codex SDK ended without Forge MCP tool calls."), { code: "CODEX_MCP_TOOL_CALLS_MISSING" });
      assertTicketExecutionCompleted(codexToolEvents, { labMode, missingCode: "CODEX_MCP_TOOL_CALLS_MISSING", priorTools: priorCompletedTools });
      return { summary: result.text || "<empty response>", tool_events: codexToolEvents };
    } catch (error) {
      const failure = normalizeAgentFailure(error);
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id, agent_id: selected?.agent_id ?? null, provider: selected?.provider ?? null, target_path: targetPath, allowed_prefixes: allowedPrefixes, complexity_level: complexity?.level ?? null, changed_paths: [...resumeState.changedPaths], status: "blocked", failure: failureDetail(failure) });
      throw error;
    }
  }
}

// Converts a provider ending before report_done into an explicit terminal failure.
function normalizeAgentFailure(error) {
  if (!error || typeof error !== "object") return error;
  if (["AGENT_REPORT_MISSING", "CLAUDE_MCP_TOOL_CALLS_MISSING", "CODEX_MCP_TOOL_CALLS_MISSING"].includes(error.code)) {
    return Object.assign(new ConfigurationError("Agent process ended before report_done."), { code: "AGENT_PROCESS_EXITED", cause: error });
  }
  return error;
}

// Returns the immutable ticket manifest paths, when a signed baseline exists.
function immutableManifestPaths(executionContext = {}) {
  const checksums = executionContext?.approved_baseline?.file_checksums;
  if (checksums && typeof checksums === "object") return Object.keys(checksums).sort();
  return [];
}

// Restores exact previously claimed files so a resumed Coder can commit its durable ledger.
function resumeLedgerPaths(request) {
  const context = request.execution_context;
  if (!request.payload?.resume_from || context?.task_id !== request.task_id || !Array.isArray(context.manifest_paths)) return [];
  return context.manifest_paths.filter((path) => typeof path === "string"
    && /^(?:backend|schemas|ui|web)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(path)
    && !path.split("/").includes("..") && !isProtectedPath(path, { operation: "write" }));
}

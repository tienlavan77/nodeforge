// Runs Claude, Codex, OpenAI, and Ollama SDK flows for governed ticket work.
import { ConfigurationError } from "../../shared/errors.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../tools/claude-sdk-forge-tools.js";
import { classifyTicketComplexity } from "../../tools/ticket-complexity.js";
import { selectCodeGraphCandidatesDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition, gitStatusDefinition, gitDiffDefinition } from "../../tools/index.js";
import { saveProgressCheckpoint } from "./ticket-checkpoint-writer.js";
import { buildResumePrompt, checkpointedRegistry, createResumeState, failureDetail } from "./ticket-resume.js";
import { createExplorePrepass } from "./explore-pre-pass.js";
import { ticketCandidateScope, ticketTargetPath, prefixForPath, ticketAllowedPrefixes } from "./nodeforge-task-scope.js";
import { COMPLEXITY_FALLBACK, buildCodexTicketPrompt, buildCodexToolTestPrompt, buildToolTicketPrompt, buildToolTestPrompt } from "./nodeforge-task-prompts.js";
import { assertTicketExecutionCompleted, collectToolCalls, extractText, sdkToolEvent } from "./nodeforge-task-sdk-events.js";

// Creates SDK executors that keep Claude and Claude Code ticket policies aligned.
export function createNodeforgeTaskExecutors({ claudeSdkGateway, openaiSdkGateway, codexSdkGateway, ollamaSdkGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger, checkpoints, relevantTreeSelector, protocolStorage }) {
  return Object.freeze({ runOpenAiHello, runOllamaHello, runToolTicket, runCodexTask });

  async function runToolTicket(selected, request) {
    if (typeof claudeSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Claude SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const traced = ticketCandidateScope(ticket);
    // eslint-disable-next-line no-silent-catch -- Explore pre-pass is optional; ticket execution falls back to explicit scope.
    const prepass = traced ? null : relevantTreeSelector ? await createExplorePrepass({ relevantTreeSelector, protocolStorage }).run({ ticket }).catch(() => null) : null;
    const targetPath = labMode?.target_path ?? traced?.targetPath ?? prepass?.targetPath ?? ticketTargetPath(ticket);
    const allowedPrefixes = [...new Set([...(labMode?.allowed_prefixes ?? []), ...(traced?.allowedPrefixes ?? []), ...(prepass?.allowedPrefixes ?? []), ...prefixForPath(targetPath), ...ticketAllowedPrefixes(ticket)])];
    if (!targetPath) throw Object.assign(new ConfigurationError("Ticket target is ambiguous; provide an implementation path in the ticket objective or acceptance criteria."), { code: "TICKET_TARGET_MISSING" });
    const allowedFilePaths = [targetPath, "backend/package.json"].filter(Boolean);
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const resumeState = createResumeState(request.payload?.resume_from ?? null, complexity);
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id, execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: ["select_code_graph_candidates", "search_code", "read_file", "write_diff", "edit_diff", "run_test", "check_test", "git_status", "git_diff", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, changed_paths: [...resumeState.changedPaths],
      context_budget: { max_bytes: 1000000, max_calls: 12 }, discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls, discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls, discovery_edit_must_start_by: complexity.edit_must_start_by,
      discovery_target_path: targetPath, allow_discovery_escalation: complexity.allow_escalation ?? complexity.level !== "simple",
      lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, project_root: projectRoot, ticket, task: ticket, task_context: ticket, changed_paths: [...resumeState.changedPaths], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id, resumeState, labMode: Boolean(labMode) });
    const mcpServers = { forge: createForgeSdkMcpServer({ registry: checkpointed, context: toolContext, includeCommit: true }) };
    let result;
    try {
      result = await claudeSdkGateway.execute({
        agentId: selected.agent_id, correlationId: request.correlation_id, cwd: projectRoot,
        options: { tools: [], mcpServers, allowedTools: forgeSdkToolNames, maxTurns: complexity.max_turns, effort: complexity.effort, thinking: complexity.thinking },
        resumeSessionId: resumeState.sessionId,
        onSessionReady: (sessionId) => { if (typeof sessionId === "string" && sessionId) resumeState.sessionId = sessionId; saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id }); },
        prompt: buildResumePrompt(labMode ? buildToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity), resumeState, { agentId: selected.agent_id, provider: selected.provider, changedPaths: toolContext.changed_paths })
      });
    } catch (error) {
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id, agent_id: selected?.agent_id ?? null, provider: selected?.provider ?? null, target_path: targetPath, allowed_prefixes: allowedPrefixes, complexity_level: complexity?.level ?? null, changed_paths: [...resumeState.changedPaths], failure: failureDetail(error) });
      throw error;
    }
    const toolEvents = collectToolCalls(result.messages);
    assertTicketExecutionCompleted(toolEvents, { labMode, missingCode: "CLAUDE_MCP_TOOL_CALLS_MISSING" });
    return { summary: extractText(result.messages).filter(Boolean).join(" ").trim() || "<empty response>", tool_events: toolEvents };
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
    const traced = ticketCandidateScope(ticket);
    // eslint-disable-next-line no-silent-catch -- Explore pre-pass is optional; ticket execution falls back to explicit scope.
    const prepass = traced ? null : relevantTreeSelector ? await createExplorePrepass({ relevantTreeSelector, protocolStorage }).run({ ticket }).catch(() => null) : null;
    const targetPath = labMode?.target_path ?? traced?.targetPath ?? prepass?.targetPath ?? ticketTargetPath(ticket);
    const allowedPrefixes = [...new Set([...(labMode?.allowed_prefixes ?? []), ...(traced?.allowedPrefixes ?? []), ...(prepass?.allowedPrefixes ?? []), ...prefixForPath(targetPath), ...ticketAllowedPrefixes(ticket)])];
    if (!targetPath) throw Object.assign(new ConfigurationError("Ticket target is ambiguous; provide an implementation path in the ticket objective or acceptance criteria."), { code: "TICKET_TARGET_MISSING" });
    const allowedFilePaths = [targetPath, "backend/package.json"].filter(Boolean);
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const resumeState = createResumeState(request.payload?.resume_from ?? null, complexity);
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id, execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: ["select_code_graph_candidates", "rg_files", "rg_search", "sed_lines", "write_diff", "edit_diff", "run_test", "check_test", "git_status", "git_diff", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, changed_paths: [...resumeState.changedPaths],
      context_budget: { max_bytes: 1000000, max_calls: 12 }, discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls, discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls, discovery_edit_must_start_by: complexity.edit_must_start_by,
      discovery_target_path: targetPath, allow_discovery_escalation: complexity.allow_escalation ?? complexity.level !== "simple",
      lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, project_root: projectRoot, ticket, task: ticket, task_context: ticket, changed_paths: [...resumeState.changedPaths], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id, resumeState, labMode: Boolean(labMode) });
    const definitions = [selectCodeGraphCandidatesDefinition, rgFilesDefinition, rgSearchDefinition, sedLinesDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, gitStatusDefinition, gitDiffDefinition, commitChangesDefinition, reportDoneDefinition];
    const forgeToolNames = new Set(definitions.map((definition) => definition.name));
    const codexToolEvents = [];
    let result;
    try {
      result = await codexSdkGateway.execute({
        agentId: selected.agent_id, correlationId: request.correlation_id, cwd: projectRoot, resumeThreadId: resumeState.threadId,
        onSessionReady: (threadId, toolNames) => {
          if (typeof threadId === "string" && threadId) resumeState.threadId = threadId;
          if (Array.isArray(toolNames)) projectLogger({ event_name: "supervisor.codex_mcp_session_ready", level: "info", status: "success", message: "Codex Forge MCP session ready.", task_id: request.task_id, correlation_id: request.correlation_id, source: "codex-sdk-ticket", payload: { request_id: request.request_id, agent_id: selected.agent_id, tools: toolNames } });
          saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id });
        },
        options: { model: selected.model, forgeTools: { registry: checkpointed, context: toolContext, definitions }, approvalPolicy: labMode?.approval_policy ?? "on-request" },
        prompt: buildResumePrompt(labMode ? buildCodexToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity), resumeState, { agentId: selected.agent_id, provider: selected.provider, changedPaths: toolContext.changed_paths }),
        onEvent: async (event) => {
          const toolEvent = sdkToolEvent(event, forgeToolNames);
          if (!toolEvent) return;
          codexToolEvents.push(toolEvent);
          projectLogger({ event_name: "supervisor.agent_tool_event", level: toolEvent.status === "failed" ? "error" : "info", status: toolEvent.status === "failed" ? "failed" : "success", message: `Codex Forge MCP tool ${toolEvent.tool} ${toolEvent.status}.`, task_id: request.task_id, ticket_id: request.task_id, correlation_id: request.correlation_id, source: labMode ? "codex-sdk-tool-lab" : "codex-sdk-ticket", payload: { request_id: request.request_id, agent_id: selected.agent_id, server: "forge", tool: toolEvent.tool, item_id: toolEvent.item_id, arguments: toolEvent.arguments, result: toolEvent.result, error: toolEvent.error } });
        }
      });
    } catch (error) {
      await saveProgressCheckpoint(checkpoints, resumeState, { task_id: request.task_id, correlation_id: request.correlation_id, agent_id: selected?.agent_id ?? null, provider: selected?.provider ?? null, target_path: targetPath, allowed_prefixes: allowedPrefixes, complexity_level: complexity?.level ?? null, changed_paths: [...resumeState.changedPaths], failure: failureDetail(error) });
      throw error;
    }
    if (codexToolEvents.length === 0) throw Object.assign(new ConfigurationError("Codex SDK did not expose Forge MCP tool calls to the session."), { code: "CODEX_MCP_TOOL_CALLS_MISSING" });
    assertTicketExecutionCompleted(codexToolEvents, { labMode, missingCode: "CODEX_MCP_TOOL_CALLS_MISSING" });
    return { summary: result.text || "<empty response>", tool_events: codexToolEvents };
  }
}

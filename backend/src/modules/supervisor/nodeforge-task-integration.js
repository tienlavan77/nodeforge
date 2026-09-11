import { ConfigurationError } from "../../shared/errors.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../tools/claude-sdk-forge-tools.js";
import { readFileDefinition, writeDiffDefinition, runTestDefinition, commitChangesDefinition, reportDoneDefinition, searchCodeDefinition } from "../../tools/index.js";

import { createCodexForgeToolLoop } from "../agent/codex-forge-tool-loop.js";

export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, handoffQueue, claudeSdkGateway, openaiSdkGateway, agentGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {} } = {}) {
  if (typeof supervisorManager?.startTask !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("NodeForge integration requires Supervisor Manager and Event Bus.");
  if (typeof handoffQueue?.enqueue !== "function") throw new ConfigurationError("NodeForge integration requires a sender handoff queue.");
  const publishedOwners = new Set();
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
    console.log(`[supervisor] ticket ${request.task_id} -> sender ${queued?.id ?? "<no-job-id>"} -> agent ${selected.agent_name} (${selected.role}, ${selected.agent_id})`);
    let result;
    try {
      projectLogger({ event_name: "supervisor.agent_execution_started", level: "info", status: "started", message: "Supervisor started Agent execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null } });
      console.log(`[supervisor] starting Agent execution for ${selected.agent_name}`);
      result = isOpenAiProfile(selected)
        ? await runOpenAiHello(selected, request)
        : isCodexProfile(selected)
          ? await runCodexTask(selected, request)
        : await runToolTicket(selected, request);
    } catch (error) {
      projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Agent Forge tool ticket failed.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: request.request_id, agent_id: selected.agent_id, error: error.message } });
      console.error(`[supervisor] Forge tool ticket failed: ${error.message}`);
      throw error;
    }
    projectLogger({ event_name: "supervisor.agent_execution_completed", level: "info", status: "success", message: "Agent completed execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null, tool_events: result.tool_events } });
    console.log(`[supervisor] agent ${selected.agent_name} completed execution: ${result.summary}`);
    return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status: "completed", job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
  }

  async function runToolTicket(selected, request) {
    if (typeof claudeSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Claude SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const targetPath = request.payload?.tool_test?.target_path ?? "backend/tool-lab-target.txt";
    const allowedPrefixes = request.payload?.tool_test?.allowed_prefixes ?? ["backend/"];
    const ticket = { ...request.ticket, id: request.task_id };
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id,
      execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, role: selected.role },
      capabilities: ["search_code", "read_file", "write_diff", "run_test", "check_test", "report_done"],
      allowed_file_paths: [targetPath, "backend/package.json"],
      allowed_prefixes: allowedPrefixes,
      lifecycle: "RUNNING",
      audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [targetPath], allowed_file_paths: [targetPath, "backend/package.json"], allowed_prefixes: allowedPrefixes, session_id: executionId };
    const mcpServers = { forge: createForgeSdkMcpServer({ registry: toolRegistry, context: toolContext }) };
    const allowedTools = forgeSdkToolNames.filter((name) => name !== "mcp__forge__commit_changes");
    const result = await claudeSdkGateway.execute({
      agentId: selected.agent_id,
      correlationId: request.correlation_id,
      cwd: projectRoot,
      options: { tools: [], mcpServers, allowedTools, maxTurns: 12 },
      prompt: buildToolTicketPrompt(request.task_id, targetPath, allowedPrefixes)
    });
    return { summary: extractText(result.messages).filter(Boolean).join(" ").trim() || "<empty response>", tool_events: result.messages.flatMap(extractToolEvents) };
  }

  async function runOpenAiHello(selected, request) {
    if (typeof openaiSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires an OpenAI SDK gateway.");
    console.log(`[supervisor] starting OpenAI SDK hello for ${selected.agent_name}`);
    const result = await openaiSdkGateway.execute({
      agent: selected,
      correlationId: request.correlation_id,
      prompt: "Say hello to the NodeForge Supervisor in one short sentence."
    });
    console.log(`[openai-sdk] ${selected.agent_name}: ${result.text || "<empty response>"}`);
    return { summary: result.text || "<empty response>", tool_events: [] };
  }

  async function runCodexTask(selected, request) {
    console.log(`[supervisor] starting Codex SDK task for ${selected.agent_name}`);
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const targetPath = labMode?.target_path ?? ticketTargetPath(ticket);
    const allowedPrefixes = labMode?.allowed_prefixes ?? prefixForPath(targetPath);
    const context = runtimeGovernance?.createExecutionContext?.({ task_id: request.task_id, execution_id: executionId, agent_identity: { agent_id: selected.agent_id, role: selected.role }, capabilities: ["search_code", "read_file", "write_diff", "run_test", "commit_changes", "report_done"], allowed_file_paths: [targetPath, "backend/package.json"], allowed_prefixes: allowedPrefixes, changed_paths: [targetPath], lifecycle: "RUNNING", audit_context: { correlation_id: request.correlation_id } }) ?? {};
    const definitions = [searchCodeDefinition, readFileDefinition, writeDiffDefinition, runTestDefinition, commitChangesDefinition, reportDoneDefinition];
    const loopContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [targetPath], allowed_file_paths: [targetPath, "backend/package.json"], allowed_prefixes: allowedPrefixes, session_id: executionId };
    const codexToolEvents = [];

    // The MCP bridge path never produced a tools/call against the third-party
    // gateway, so Forge tools are driven as Responses function-calls instead.
    if (typeof agentGateway?.request !== "function") throw new ConfigurationError("NodeForge integration requires an Agent Gateway for Codex Forge tool execution.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");

    const loop = createCodexForgeToolLoop({ agentGateway });
    const result = await loop.run({
      agentId: selected.agent_id,
      correlationId: request.correlation_id,
      prompt: labMode
        ? buildCodexToolTestPrompt(request.task_id, targetPath, allowedPrefixes)
        : buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes),
      definitions,
      registry: toolRegistry,
      context: loopContext,
      onToolEvent: async (event) => {
        codexToolEvents.push({ status: event.status, server: "forge", tool: event.tool, item_id: event.call_id ?? null, arguments: diagnosticValue(event.arguments), result: diagnosticValue(event.result), error: diagnosticValue(event.error) });
        const level = event.status === "failed" ? "error" : "info";
        projectLogger({
          event_name: "supervisor.agent_tool_event",
          level,
          status: event.status === "failed" ? "failed" : "success",
          message: `Codex Forge tool ${event.tool} ${event.status}.`,
          task_id: request.task_id,
          ticket_id: request.task_id,
          correlation_id: request.correlation_id,
          source: labMode ? "codex-sdk-tool-lab" : "codex-sdk-ticket",
          payload: { request_id: request.request_id, agent_id: selected.agent_id, server: "forge", tool: event.tool, item_id: event.call_id ?? null, ...(event.arguments === undefined ? {} : { arguments: event.arguments }), ...(event.result === undefined ? {} : { result: event.result }), ...(event.error === undefined ? {} : { error: event.error }) }
        });
      }
    });
    if (codexToolEvents.length === 0) {
      throw Object.assign(new ConfigurationError("Codex provider did not expose Forge MCP tools to the session."), { code: "CODEX_MCP_TOOL_CALLS_MISSING" });
    }
    console.log(`[codex-sdk] ${selected.agent_name}: ${result.text || "<empty response>"}`);
    return { summary: result.text || "<empty response>", tool_events: codexToolEvents };
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

function isOpenAiProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "openai";
}

function isCodexProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "codex";
}

// The ticket schema forbids extra fields, so the target file must be named in
// the ticket text itself (objective or acceptance criteria). Without a
// path-like token the run falls back to the tool-lab target.
function ticketTargetPath(ticket) {
  const candidates = [ticket?.objective, ...(ticket?.acceptance_criteria ?? [])];
  for (const text of candidates) {
    if (typeof text !== "string") continue;
    for (const token of text.split(/[^A-Za-z0-9._/-]+/)) {
      if (/^[A-Za-z0-9._-]+\/[A-Za-z0-9._/-]+$/.test(token) && !token.startsWith(".") && token.includes("/")) return token;
    }
  }
  return "backend/tool-lab-target.txt";
}

function prefixForPath(path) {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? [path.slice(0, separator)] : [];
}

function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  return [
    `Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.`,
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    "",
    `The file to document is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${JSON.stringify(allowedPrefixes)}.`,
    "Work in English and produce all file content in English.",
    "Proceed as follows:",
    `1. Call read_file with exactly: ${JSON.stringify({ path: targetPath })}. You may call search_code first if you need to locate related files, with allowed_prefixes ${JSON.stringify(allowedPrefixes)}.`,
    "2. Use the sha256 returned by read_file as before_checksum for write_diff. Never send the string \"null\"; use JSON null only if read_file reported the file does not exist.",
    `3. Call write_diff for exactly path ${JSON.stringify(targetPath)}: keep every existing line of the file exactly as-is, but prepend a block comment at the very top of the file that summarizes what the file does — its purpose, main responsibilities, and key exports or functions. Do not modify or reorder any existing code, imports, or logic.`,
    "4. Optionally call run_test with {} to confirm the suite still passes.",
    `5. Call commit_changes with exactly: ${JSON.stringify({ message: `docs: add summary comment to ${targetPath}` })}.`,
    "6. Call report_done with a concise summary of the comment you added. Stop after report_done."
  ].filter((line) => line !== undefined).join("\n");
}

function buildCodexToolTestPrompt(taskId, targetPath, allowedPrefixes) {
  return [
    "Run the fixed six-tool Forge MCP integration test. Do not inspect or use any ticket title, objective, description, or acceptance criteria.",
    "For this integration test, use Forge MCP tools only; do not use built-in shell, file, patch, or search tools. If Codex displays the server-qualified names (for example mcp__forge__search_code), those are the same Forge tools and must be used.",
    "Call exactly these six Forge tools once each, in this order: search_code, read_file, write_diff, run_test, commit_changes, report_done.",
    `Call search_code with exactly: ${JSON.stringify({ query: "backend/package.json", kind: "file", limit: 5, allowed_prefixes: allowedPrefixes, projection: "minimal" })}.`,
    `Call read_file with exactly: ${JSON.stringify({ path: targetPath })}. If it succeeds, use its returned sha256 as before_checksum; if it reports that the target does not exist, use JSON null.`,
    `Call write_diff for exactly path ${JSON.stringify(targetPath)} with content exactly "tool-lab\\n" and before_checksum set to the exact checksum from read_file, or JSON null for a new target. Never send the string "null".`,
    "Call run_test with exactly {}.",
    `Call commit_changes with exactly: ${JSON.stringify({ message: `Codex Forge six-tool test ${taskId}` })}.`,
    "Call report_done with a concise summary of the six tool calls. Stop after report_done."
  ].join("\n");
}

function diagnosticValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(diagnosticValue);
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, key === "content" && typeof item === "string" ? `<redacted:${item.length} chars>` : diagnosticValue(item)]));
  }
  return value;
}

function buildToolTicketPrompt(taskId, targetPath, allowedPrefixes) {
  const writeDiffInput = {
    path: targetPath,
    content: "tool-lab\n",
    before_checksum: null
  };

  return [
    `Run the simple Forge tool test ticket ${taskId}.`,
    "Use only Forge MCP tools. Built-in SDK tools are disabled; do not use Bash, Read, Edit, Glob, or Grep.",
    "Call exactly these Forge MCP tools in order: search_code, read_file, write_diff, run_test, check_test, report_done.",
    `Call search_code once for backend/package.json with kind file, limit 5, and allowed_prefixes ${JSON.stringify(allowedPrefixes)}.`,
    "Then call read_file once for backend/package.json.",
    `Then call write_diff once with exactly this JSON input: ${JSON.stringify(writeDiffInput)}.`,
    "If write_diff returns a tool error, inspect that tool result and retry write_diff once with before_checksum set to JSON null before continuing.",
    "Then call run_test once with no arguments to start the test job and receive a job_id.",
    "Then call check_test with that job_id, repeating until the status is passed or failed; report that final status.",
    "Finally call report_done once with a concise summary. Stop after report_done."
  ].join("\n");
}

function extractToolEvents(message) {
  const values = [message, message?.message, message?.content].flatMap((value) => Array.isArray(value) ? value : [value]);
  return values.filter((item) => item?.type === "tool_use" || item?.type === "tool_result").map((item) => ({ type: item.type, name: item.name ?? item.tool_name ?? null }));
}

function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  return Object.entries(value).flatMap(([key, item]) => ["message", "content", "output"].includes(key) ? extractText(item) : []);
}

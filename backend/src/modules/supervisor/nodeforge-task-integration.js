import { ConfigurationError } from "../../shared/errors.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../tools/claude-sdk-forge-tools.js";
import { classifyTicketComplexity } from "../../tools/ticket-complexity.js";
import { selectCodeGraphCandidatesDefinition, readFileDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition, searchCodeDefinition } from "../../tools/index.js";

export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, handoffQueue, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, agentGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {} } = {}) {
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
    let result;
    try {
      projectLogger({ event_name: "supervisor.agent_execution_started", level: "info", status: "started", message: "Supervisor started Agent execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null } });
      result = isOpenAiProfile(selected)
        ? await runOpenAiHello(selected, request)
        : isCodexProfile(selected)
          ? await runCodexTask(selected, request)
        : await runToolTicket(selected, request);
    } catch (error) {
      projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Agent Forge tool ticket failed.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: request.request_id, agent_id: selected.agent_id, error: error.message } });
      throw error;
    }
    projectLogger({ event_name: "supervisor.agent_execution_completed", level: "info", status: "success", message: "Agent completed execution.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { request_id: request.request_id, agent_id: selected.agent_id, provider: selected.provider ?? null, tool_events: result.tool_events } });
    return { task_id: request.task_id, request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, status: "completed", job_id: queued?.id, response: result.summary, tool_events: result.tool_events };
  }

  async function runToolTicket(selected, request) {
    if (typeof claudeSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Claude SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const targetPath = labMode?.target_path ?? ticketTargetPath(ticket);
    const allowedPrefixes = [...new Set([...(labMode?.allowed_prefixes ?? []), ...prefixForPath(targetPath), ...ticketAllowedPrefixes(ticket)])];
    const allowedFilePaths = [targetPath, "backend/package.json"];
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id,
      execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, role: selected.role },
      capabilities: ["select_code_graph_candidates", "search_code", "read_file", "write_diff", "edit_diff", "run_test", "check_test", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths,
      allowed_prefixes: allowedPrefixes,
      context_budget: { max_bytes: 1000000, max_calls: 12 },
      discovery_budget: complexity.discovery_budget,
      lifecycle: "RUNNING",
      audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, session_id: executionId };
    const mcpServers = { forge: createForgeSdkMcpServer({ registry: toolRegistry, context: toolContext, includeCommit: true }) };
    const allowedTools = forgeSdkToolNames;
    const result = await claudeSdkGateway.execute({
      agentId: selected.agent_id,
      correlationId: request.correlation_id,
      cwd: projectRoot,
      options: { tools: [], mcpServers, allowedTools, maxTurns: complexity.max_turns, effort: complexity.effort, thinking: complexity.thinking },
      prompt: labMode ? buildToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity)
    });
    const toolEvents = collectToolCalls(result.messages);
    assertTicketExecutionCompleted(toolEvents, { labMode, missingCode: "CLAUDE_MCP_TOOL_CALLS_MISSING" });
    return { summary: extractText(result.messages).filter(Boolean).join(" ").trim() || "<empty response>", tool_events: toolEvents };
  }

  async function runOpenAiHello(selected, request) {
    if (typeof openaiSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires an OpenAI SDK gateway.");
    const result = await openaiSdkGateway.execute({
      agent: selected,
      correlationId: request.correlation_id,
      prompt: "Say hello to the NodeForge Supervisor in one short sentence."
    });
    return { summary: result.text || "<empty response>", tool_events: [] };
  }

  async function runCodexTask(selected, request) {
    if (typeof codexSdkGateway?.execute !== "function") throw new ConfigurationError("NodeForge integration requires a Codex SDK gateway.");
    if (!toolRegistry || typeof runtimeGovernance?.createExecutionContext !== "function") throw new ConfigurationError("NodeForge integration requires governed Forge tools.");
    const executionId = `${request.task_id}:${request.request_id}`;
    const ticket = { ...request.ticket, id: request.task_id };
    const labMode = request.payload?.tool_test;
    const targetPath = labMode?.target_path ?? ticketTargetPath(ticket);
    const allowedPrefixes = [...new Set([...(labMode?.allowed_prefixes ?? []), ...prefixForPath(targetPath), ...ticketAllowedPrefixes(ticket)])];
    const allowedFilePaths = [targetPath, "backend/package.json"];
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id,
      execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, role: selected.role },
      capabilities: ["select_code_graph_candidates", "search_code", "read_file", "write_diff", "edit_diff", "run_test", "check_test", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths,
      allowed_prefixes: allowedPrefixes,
      changed_paths: [],
      context_budget: { max_bytes: 1000000, max_calls: 12 },
      discovery_budget: complexity.discovery_budget,
      lifecycle: "RUNNING",
      audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, session_id: executionId };
    const definitions = [selectCodeGraphCandidatesDefinition, searchCodeDefinition, readFileDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition];
    const forgeToolNames = new Set(definitions.map((definition) => definition.name));
    const codexToolEvents = [];
    const result = await codexSdkGateway.execute({
      agentId: selected.agent_id,
      correlationId: request.correlation_id,
      cwd: projectRoot,
      onSessionReady: (toolNames) => projectLogger({ event_name: "supervisor.codex_mcp_session_ready", level: "info", status: "success", message: "Codex Forge MCP session ready.", task_id: request.task_id, correlation_id: request.correlation_id, source: "codex-sdk-ticket", payload: { request_id: request.request_id, agent_id: selected.agent_id, tools: toolNames } }),
      options: {
        model: selected.model,
        forgeTools: { registry: toolRegistry, context: toolContext, definitions },
        approvalPolicy: labMode?.approval_policy ?? "on-request"
      },
      prompt: labMode
        ? buildCodexToolTestPrompt(request.task_id, targetPath, allowedPrefixes)
        : buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity),
      onEvent: async (event) => {
        const toolEvent = sdkToolEvent(event, forgeToolNames);
        if (!toolEvent) return;
        codexToolEvents.push(toolEvent);
        projectLogger({
          event_name: "supervisor.agent_tool_event",
          level: toolEvent.status === "failed" ? "error" : "info",
          status: toolEvent.status === "failed" ? "failed" : "success",
          message: `Codex Forge MCP tool ${toolEvent.tool} ${toolEvent.status}.`,
          task_id: request.task_id,
          ticket_id: request.task_id,
          correlation_id: request.correlation_id,
          source: labMode ? "codex-sdk-tool-lab" : "codex-sdk-ticket",
          payload: { request_id: request.request_id, agent_id: selected.agent_id, server: "forge", tool: toolEvent.tool, item_id: toolEvent.item_id, arguments: toolEvent.arguments, result: toolEvent.result, error: toolEvent.error }
        });
      }
    });
    if (codexToolEvents.length === 0) throw Object.assign(new ConfigurationError("Codex SDK did not expose Forge MCP tool calls to the session."), { code: "CODEX_MCP_TOOL_CALLS_MISSING" });
    assertTicketExecutionCompleted(codexToolEvents, { labMode, missingCode: "CODEX_MCP_TOOL_CALLS_MISSING" });
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
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ");
  if (/\b(sprint|dashboard|button|modal|frontend|react|next(?:\.js)?)\b/i.test(text)) return "ui/nextjs/components/NodeForgePanels.jsx";
  return "backend/tool-lab-target.txt";
}

function prefixForPath(path) {
  const separator = path.lastIndexOf("/");
  return separator > 0 ? [path.slice(0, separator)] : [];
}

function ticketAllowedPrefixes(ticket) {
  const text = [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])].filter((value) => typeof value === "string").join(" ");
  const prefixes = [];
  if (/\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout)\b/i.test(text)) prefixes.push("ui/nextjs/", "ui/src/", "web/src/");
  return prefixes;
}

function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const instructions = targetPath === "backend/tool-lab-target.txt"
    ? [
      `The inferred target is ${JSON.stringify(targetPath)}; if that file does not exist, choose the real implementation file(s) inside allowed prefixes ${allowedJson} by using search_code — do not invent a new unrelated file.`,
      `If you must create a new file, limit it to a prefix inside ${allowedJson}.`
    ]
    : [
      `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it.`,
      "Discovery sequence: (1) call select_code_graph_candidates with a query summarizing the ticket intent to get up to four candidate files with their import relations; (2) to explore an unfamiliar file, first run one kind=\"file\" search with projection=\"summary\" to get its symbol map, then read targeted windows; (3) call search_code with kind=\"content\" ONLY on identifiers, function names, or strings you have already seen in a previous tool result — never search for text you are guessing at (UI labels, headings, or ticket phrasing do not exist in code). If the first candidate round misses part of the scope, call select_code_graph_candidates again with a narrower query and what you already learned in context. Do not assume a file path that returned ENOENT."
    ];
  return [
    `Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.`,
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    "",
    ...instructions,
    "Work in English and produce all file content in English.",
    // Budget discipline: exploration must end and the run must finish within
    // the gateway wall-clock timeout. Past runs died exploring (15+ searches)
    // and timed out before edit_diff/commit. The budget comes from the ticket
    // complexity classification so simple tickets are not over-provisioned.
    `Budget discipline: you have a hard wall-clock deadline and a discovery budget of ${complexity.discovery_budget} exploration calls, then START EDITING. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    "Search discipline: select_code_graph_candidates is your map — read its candidate files first. To explore an unfamiliar file, run one kind=\"file\" search with projection=\"summary\" for its symbol map, then read targeted windows. Never search for text you are guessing at (UI labels, headings, ticket phrasing); search_code exists ONLY to verify or extend identifiers you already saw in a tool result. If a search_code call returns 0 matches, do not rephrase the same guess — read a candidate file window instead.",
    "Tool enforcement: read_file on files over 500 lines returns only a 40-line preview — always pass offset/limit windows. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Use the sha256 returned by read_file as before_checksum for write_diff/edit_diff. Never send the string \"null\"; use JSON null only when read_file reports the file does not exist and a new file is intentionally required.",
    `When the ticket is satisfied, call commit_changes with an appropriate commit message and then report_done with a concise summary. Stop after report_done.`
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

function sdkToolEvent(event, forgeToolNames) {
  if (event?.type !== "item.completed") return null;
  const item = event.item;
  if (!item || !["mcp_tool_call", "mcp_tool_result", "tool_use", "tool_result"].includes(item.type)) return null;
  const tool = normalizeForgeToolName(item.name ?? item.tool_name ?? item.tool);
  if (!tool || (forgeToolNames && !forgeToolNames.has(tool)) || (item.server && item.server !== "forge")) return null;
  const failed = item.status === "failed" || item.is_error === true || item.error != null;
  return {
    status: failed ? "failed" : "success",
    server: "forge",
    tool,
    item_id: item.call_id ?? item.id ?? null,
    arguments: diagnosticValue(item.arguments ?? item.input),
    result: diagnosticValue(item.result ?? item.output),
    error: diagnosticValue(item.error),
    error_code: extractResultErrorCode(item)
  };
}

// MCP tool failures carry the structured error_code inside the result content
// text (e.g. {"error_code":"GIT_EMPTY_COMMIT"}); item.error_code itself is null.
function extractResultErrorCode(item) {
  if (typeof item?.error_code === "string") return item.error_code;
  if (typeof item?.error?.code === "string") return item.error.code;
  const content = Array.isArray(item?.result?.content) ? item.result.content : [];
  const text = content.find((part) => typeof part?.text === "string")?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.error_code === "string" ? parsed.error_code : null;
  } catch {
    return null;
  }
}

function normalizeForgeToolName(name) {
  return typeof name === "string" ? name.replace(/^mcp__forge__/, "") : null;
}

// Tool-lab runs skip classification (synthetic ticket); these are the previous
// hardcoded defaults, now also the complex-tier budget floor.
const COMPLEXITY_FALLBACK = Object.freeze({ effort: "medium", discovery_budget: 8, max_turns: 40, thinking: { type: "enabled", budgetTokens: 4096 } });
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

function buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const instructions = targetPath === "backend/tool-lab-target.txt"
    ? [
      `The inferred target is ${JSON.stringify(targetPath)}; if that file does not exist, choose the real implementation file(s) inside allowed prefixes ${allowedJson} by using search_code — do not invent a new unrelated file.`
    ]
    : [
      `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it.`,
      "Discovery sequence: (1) call select_code_graph_candidates with a query summarizing the ticket intent to get up to four candidate files with their import relations; (2) to explore an unfamiliar file, first run one kind=\"file\" search with projection=\"summary\" to get its symbol map, then read targeted windows of at most 200 lines; (3) call search_code with kind=\"content\" ONLY on identifiers, function names, or strings you have already seen in a previous tool result — never search for text you are guessing at (UI labels, headings, or ticket phrasing do not exist in code). Do not assume a file path that returned ENOENT."
    ];
  return [
    "Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    "",
    ...instructions,
    `Budget discipline: you have a hard turn limit and a discovery budget of ${complexity.discovery_budget} exploration calls, then START EDITING. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    "Search discipline: select_code_graph_candidates is your map — read its candidate files first. Never search for text you are guessing at (UI labels, headings, ticket phrasing); search_code exists ONLY to verify or extend identifiers you already saw in a tool result. If a search_code call returns 0 matches, do not rephrase the same guess — read a candidate file window instead.",
    "Tool enforcement: read_file on files over 500 lines returns only a 40-line preview — always pass offset/limit windows. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Use the checksum returned by read_file as before_checksum for write_diff/edit_diff; never send the string \"null\". Use JSON null only when intentionally creating a new file.",
    "For an existing file, use edit_diff with a small exact anchor and replacement. Use write_diff only for a new file or an existing file no larger than 8 KB. If write_diff returns DESTRUCTIVE_OVERWRITE or CONTENT_TOO_LARGE, retry with edit_diff; do not stop or report done.",
    "If a governed tool call fails, fix the inputs or stop — do not continue with write_diff/commit_changes on an unknown target.",
    "Call report_done with a concise summary after completing the ticket. Stop after report_done."
  ].join("\n");
}

function buildToolTestPrompt(taskId, targetPath, allowedPrefixes) {
  const writeDiffInput = { path: targetPath, content: "tool-lab\n", before_checksum: null };
  return [
    `Run the fixed six-tool Forge MCP integration test ${taskId}.`,
    "Use only Forge MCP tools; do not use built-in shell, file, patch, or search tools.",
    "Call exactly these Forge MCP tools in order: search_code, read_file, write_diff, run_test, check_test, report_done.",
    `Call search_code once for backend/package.json with kind file, limit 5, and allowed_prefixes ${JSON.stringify(allowedPrefixes)}.`,
    "Then call read_file once for backend/package.json.",
    `Then call write_diff once with exactly this JSON input: ${JSON.stringify(writeDiffInput)}.`,
    "Then call run_test once with no arguments, check the returned job, and report the final status.",
    "Finally call report_done once with a concise summary. Stop after report_done."
  ].join("\n");
}

function assertTicketExecutionCompleted(toolEvents, { labMode = false, missingCode = "TOOL_EXECUTION_FAILED" } = {}) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) throw Object.assign(new ConfigurationError("Agent did not expose Forge tool calls to the session."), { code: missingCode });
  const successful = toolEvents.filter((event) => event.status !== "failed");
  const names = successful.map((event) => event.name ?? event.tool);
  if (!names.includes("report_done")) throw Object.assign(new ConfigurationError("Agent ended without recording a completion report."), { code: "AGENT_REPORT_MISSING" });
  if (labMode) return;

  const applied = names.includes("write_diff") || names.includes("edit_diff");
  const inspected = names.includes("read_file") || names.includes("search_code");
  const emptyCommit = toolEvents.some((event) =>
    (event.name ?? event.tool) === "commit_changes" &&
    event.status === "failed" &&
    event.error_code === "GIT_EMPTY_COMMIT"
  );
  // A failed commit_changes no longer invalidates an attempt where files were
  // genuinely written: the worktree still holds the applied changes, so the
  // run completes with a warning and the operator commits or repairs manually.
  if (applied && emptyCommit) return;
  if ((!applied || !names.includes("commit_changes")) && !(inspected && emptyCommit)) {
    throw Object.assign(new ConfigurationError("Agent ended without applying and committing ticket changes."), { code: "AGENT_CHANGES_MISSING" });
  }
}

function collectToolCalls(messages) {
  const raw = messages.flatMap(extractToolEvents);
  const failedIds = new Set(raw.filter((item) => item.type === "tool_result" && item.is_error).map((item) => item.id).filter(Boolean));
  const resultsById = new Map(raw.filter((item) => item.type === "tool_result" && item.id).map((item) => [item.id, item]));
  return raw
    .filter((item) => item.type === "tool_use")
    .map((item) => ({
      ...item,
      status: failedIds.has(item.id) ? "failed" : "success",
      error_code: resultsById.get(item.id)?.error_code ?? null,
      tool: item.name
    }));
}

function extractToolEvents(message) {
  const blocks = [message?.content, message?.message?.content, message?.message, message].flatMap((value) => Array.isArray(value) ? value : [value]);
  return blocks
    .filter((item) => item?.type === "tool_use" || item?.type === "tool_result")
    .map((item) => ({ type: item.type, id: item.id ?? item.tool_use_id ?? null, is_error: item.is_error === true, error_code: normalizeToolErrorCode(item), name: normalizeForgeToolName(item.name ?? item.tool_name), tool_name: item.name ?? item.tool_name ?? null }));
}

function normalizeToolErrorCode(block) {
  if (typeof block?.error_code === "string") return block.error_code;
  if (typeof block?.error?.code === "string") return block.error.code;
  const content = Array.isArray(block?.content) ? block.content : [];
  const text = content.find((part) => typeof part?.text === "string")?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.error_code === "string" ? parsed.error_code : null;
  } catch {
    return null;
  }
}

function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  return Object.entries(value).flatMap(([key, item]) => ["message", "content", "output"].includes(key) ? extractText(item) : []);
}

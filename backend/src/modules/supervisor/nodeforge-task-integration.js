// nodeforge task integration - provides nodeforge task integration functionality for NodeForge.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../../shared/errors.js";
import { createForgeSdkMcpServer, forgeSdkToolNames } from "../../tools/claude-sdk-forge-tools.js";
import { classifyTicketComplexity } from "../../tools/ticket-complexity.js";
import { createAgentExecutionCheckpointStore } from "../agent/agent-execution-checkpoint.js";
import { selectCodeGraphCandidatesDefinition, readFileDefinition, writeDiffDefinition, editDiffDefinition, runTestDefinition, checkTestDefinition, commitChangesDefinition, reportDoneDefinition, searchCodeDefinition } from "../../tools/index.js";

// createNodeforgeTaskIntegration - handles createNodeforgeTaskIntegration operation.
export function createNodeforgeTaskIntegration({ supervisorManager, eventBus, agentResolver, handoffQueue, claudeSdkGateway, openaiSdkGateway, codexSdkGateway, agentGateway, toolRegistry, runtimeGovernance, projectRoot, projectLogger = () => {}, fileService, checkpointStore } = {}) {
  if (typeof supervisorManager?.startTask !== "function" || typeof eventBus?.publish !== "function") throw new ConfigurationError("NodeForge integration requires Supervisor Manager and Event Bus.");
  if (typeof handoffQueue?.enqueue !== "function") throw new ConfigurationError("NodeForge integration requires a sender handoff queue.");
  const checkpoints = checkpointStore ?? (fileService ? createAgentExecutionCheckpointStore({ fileService }) : null);
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
      projectLogger({ event_name: "supervisor.tool_ticket_failed", level: "error", status: "failed", message: "Ticket execution failed.", task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", error_code: error.code ?? "TOOL_TICKET_FAILED", payload: { request_id: request.request_id, agent_id: selected.agent_id, agent_name: selected.agent_name, ...(error.tool ? { tool: error.tool } : {}), error: error.message } });
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
    if (!targetPath && !allowedPrefixes.length) throw Object.assign(new ConfigurationError("Ticket target is ambiguous; provide an implementation path in the ticket objective or acceptance criteria."), { code: "TICKET_TARGET_MISSING" });
    const allowedFilePaths = [targetPath, "backend/package.json"].filter(Boolean);
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id,
      execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: ["select_code_graph_candidates", "search_code", "read_file", "write_diff", "edit_diff", "run_test", "check_test", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths,
      allowed_prefixes: allowedPrefixes,
      context_budget: { max_bytes: 1000000, max_calls: 12 },
      discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls,
      discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls,
      discovery_edit_must_start_by: complexity.edit_must_start_by,
      discovery_target_path: targetPath,
      allow_discovery_escalation: complexity.allow_escalation ?? complexity.level !== "simple",
      lifecycle: "RUNNING",
      audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id });
    const mcpServers = { forge: createForgeSdkMcpServer({ registry: checkpointed, context: toolContext, includeCommit: true }) };
    const allowedTools = forgeSdkToolNames;
    const resume = request.payload?.resume_from ?? null;
    const resumeSessionId = resume?.session_id ?? null;
    const result = await claudeSdkGateway.execute({
      agentId: selected.agent_id,
      correlationId: request.correlation_id,
      cwd: projectRoot,
      options: { tools: [], mcpServers, allowedTools, maxTurns: complexity.max_turns, effort: complexity.effort, thinking: complexity.thinking },
      resumeSessionId,
      onSessionReady: (sessionId) => checkpoints?.save({ ...(resume ?? {}), task_id: request.task_id, session_id: sessionId, status: "in_progress" }).catch(() => {}),
      prompt: withResumePrefix(labMode ? buildToolTestPrompt(request.task_id, targetPath, allowedPrefixes) : buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity), request.payload?.resume_from)
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
    if (!targetPath && !allowedPrefixes.length) throw Object.assign(new ConfigurationError("Ticket target is ambiguous; provide an implementation path in the ticket objective or acceptance criteria."), { code: "TICKET_TARGET_MISSING" });
    const allowedFilePaths = [targetPath, "backend/package.json"].filter(Boolean);
    const complexity = labMode ? { level: "moderate", ...COMPLEXITY_FALLBACK } : classifyTicketComplexity(ticket);
    projectLogger({ event_name: "supervisor.ticket_complexity", level: "info", status: "success", message: `Ticket classified as ${complexity.level}.`, task_id: request.task_id, correlation_id: request.correlation_id, source: "nodeforge-task-integration", payload: { complexity_level: complexity.level, effort: complexity.effort, discovery_budget: complexity.discovery_budget, max_turns: complexity.max_turns, reasoning: complexity.reasoning } });
    const context = runtimeGovernance.createExecutionContext({
      task_id: request.task_id,
      execution_id: executionId,
      agent_identity: { agent_id: selected.agent_id, agent_name: selected.agent_name, role: selected.role, provider: selected.provider ?? null },
      capabilities: ["select_code_graph_candidates", "search_code", "read_file", "write_diff", "edit_diff", "run_test", "check_test", "commit_changes", "report_done"],
      allowed_file_paths: allowedFilePaths,
      allowed_prefixes: allowedPrefixes,
      changed_paths: [],
      context_budget: { max_bytes: 1000000, max_calls: 12 },
      discovery_budget: complexity.discovery_budget,
      discovery_candidate_calls: complexity.candidate_calls,
      discovery_search_calls: complexity.search_calls,
      discovery_read_calls: complexity.read_calls,
      discovery_edit_must_start_by: complexity.edit_must_start_by,
      discovery_target_path: targetPath,
      allow_discovery_escalation: complexity.allow_escalation ?? complexity.level !== "simple",
      lifecycle: "RUNNING",
      audit_context: { correlation_id: request.correlation_id }
    });
    const toolContext = { ...context, ticket, task: ticket, task_context: ticket, changed_paths: [], allowed_file_paths: allowedFilePaths, allowed_prefixes: allowedPrefixes, lab_mode: Boolean(labMode), session_id: executionId, target_path: targetPath };
    const checkpointed = checkpointedRegistry({ store: checkpoints, registry: toolRegistry, taskId: request.task_id, targetPath, allowedPrefixes, complexity, selected, correlationId: request.correlation_id });
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
        forgeTools: { registry: checkpointed, context: toolContext, definitions },
        approvalPolicy: labMode?.approval_policy ?? "on-request"
      },
      prompt: withResumePrefix(
        labMode
          ? buildCodexToolTestPrompt(request.task_id, targetPath, allowedPrefixes)
          : buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity),
        request.payload?.resume_from
      ),
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

// A RUN after a VPS crash resumes from the per-turn checkpoint instead of
// restarting the agent. completed_tools ran successfully before the crash;
// the worktree still holds their file changes, so the agent must NOT repeat
// them — it continues with the next tool in the ticket sequence.
function withResumePrefix(prompt, resume) {
  if (!resume || typeof resume !== "object") return prompt;
  const done = (resume.completed_tools ?? []).join(", ") || "(none recorded)";
  return [
    `RESUMED RUN: a previous execution crashed after completing turn ${resume.last_completed_turn ?? 0}.`,
    `Tools already completed successfully (do NOT call them again for the same inputs): ${done}.`,
    `Their file changes are already in the worktree — verify with read_file if needed, then continue with the next step.`,
    `Previous agent: ${resume.agent_id ?? "unknown"} (${resume.provider ?? "unknown provider"}).`,
    "",
    prompt
  ].join("\n");
}

// isOpenAiProfile - handles isOpenAiProfile operation.
function isOpenAiProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "openai";
}

// Wraps the governed Forge tool registry so that after every successful tool
// call the current progress is durably checkpointed. On VPS crash mid-run, the
// next RUN loads this checkpoint and resumes from the last completed turn
// instead of restarting the agent from scratch. Once report_done succeeds the
// checkpoint is marked completed (retained for auditing), so resume no longer
// applies unless the caller forces a fresh run.
function checkpointedRegistry({ store, registry, taskId, targetPath, allowedPrefixes, complexity, selected, correlationId }) {
  if (!store || !registry) return registry;
  const turnCount = { value: 0 };
  const maxTurns = Number.isInteger(complexity?.max_turns) && complexity.max_turns > 0 ? complexity.max_turns : null;
  const completedTools = [];
  const wrapped = {};
  for (const [name, tool] of Object.entries(registry)) {
    if (typeof tool?.execute !== "function") { wrapped[name] = tool; continue; }
    wrapped[name] = Object.freeze({
      ...tool,
      async execute(input, context) {
        if (maxTurns !== null && turnCount.value >= maxTurns && name !== "report_done") {
          throw Object.assign(new ConfigurationError(`Turn limit reached (${turnCount.value}/${maxTurns}). The ONLY remaining allowed tool is report_done; use it to summarize the work performed so far, then stop.`), { code: "MAX_TURNS_EXCEEDED" });
        }
        const result = await tool.execute(input, context);
        turnCount.value += 1;
        completedTools.push(name);
        const done = name === "report_done";
        const changedSnapshot = Array.isArray(context?.changed_paths) ? [...context.changed_paths] : [];
        if (done) await store.complete(taskId, { completed_tools: [...completedTools], last_tool: name, changed_paths: changedSnapshot }).catch(() => {});
        else {
          await store.save({
            task_id: taskId,
            correlation_id: correlationId,
            agent_id: selected?.agent_id ?? null,
            provider: selected?.provider ?? null,
            target_path: targetPath,
            allowed_prefixes: allowedPrefixes,
            complexity_level: complexity?.level ?? null,
            last_completed_turn: turnCount.value,
            completed_tools: [...completedTools],
            last_tool: name,
            changed_paths: changedSnapshot,
            status: "in_progress"
          }).catch(() => {});
        }
        return result;
      }
    });
  }
  return wrapped;
}

// isCodexProfile - handles isCodexProfile operation.
function isCodexProfile(profile) {
  return String(profile?.provider ?? "").toLowerCase() === "codex";
}

// The ticket schema forbids extra fields, so the target file must be named in
// the ticket text itself (objective or acceptance criteria). Real tickets never
// fall back to the tool-lab marker; lab targets are supplied explicitly via
// payload.tool_test.
function ticketTargetPath(ticket) {
  const candidates = [ticket?.objective, ...(ticket?.acceptance_criteria ?? [])];
  const paths = candidates.flatMap((text) => {
    if (typeof text !== "string") return [];
    return text
      .split(/[^A-Za-z0-9._/-]+/)
      .filter((token) => /^(?:backend|schemas|ui|web)\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(token) && !token.startsWith(".") && token.includes("/"));
  });
  return paths[0] ?? null;
}

// ticketText - handles ticketText operation.
function ticketText(ticket) {
  return [ticket?.title, ticket?.objective, ...(ticket?.acceptance_criteria ?? [])]
    .filter((value) => typeof value === "string")
    .join(" ");
}

// isUiTicket - handles isUiTicket operation.
function isUiTicket(ticket) {
  return /\b(ui|frontend|front-end|react|next(?:\.js)?|component|page|button|layout|watcher|header|screen|responsive|status(?: area| line)?|dashboard|modal)\b/i.test(ticketText(ticket));
}

// prefixForPath - handles prefixForPath operation.
function prefixForPath(path) {
  if (typeof path !== "string") return [];
  const separator = path.lastIndexOf("/");
  return separator > 0 ? [path.slice(0, separator)] : [];
}

// isBackendTicket - handles isBackendTicket operation.
function isBackendTicket(ticket) {
  const text = ticketText(ticket);
  // Strong backend nouns.
  if (/\b(backend|back-end|server|endpoint|api|database|sqlite|request payload)\b/i.test(text)) return true;
  // "persist"/"db" alone are too loose: a pure frontend ticket that "persists a
  // value to localStorage" is not backend work, yet the old keyword granted
  // backend/ prefixes and forced the agent to fabricate a backend service.
  // Only count persistence when it names a server-side store.
  return /\b(persist|persistence)\b/i.test(text) && /\b(database|db|sqlite|server|backend|back-end)\b/i.test(text);
}

// ticketAllowedPrefixes - handles ticketAllowedPrefixes operation.
function ticketAllowedPrefixes(ticket) {
  const prefixes = [];
  // JSON contracts under schemas/ are low-risk data-model files that any
  // ticket may need to extend (a new field, enum, or profile). Granting the
  // whole folder unconditionally stops agents being PATH_FORBIDDEN from the
  // contract that validates the record they were told to persist.
  prefixes.push("schemas/");
  if (isUiTicket(ticket)) prefixes.push("ui/nextjs/", "ui/src/", "web/src/");
  if (isBackendTicket(ticket)) prefixes.push("backend/src/", "backend/tests/");
  return prefixes;
  return prefixes;
}

// buildCodexTicketPrompt - handles buildCodexTicketPrompt operation.
function buildCodexTicketPrompt(ticket, targetPath, allowedPrefixes, complexity) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = targetPath
    ? [
        `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it. Because the target path is explicit, skip select_code_graph_candidates and read the target directly; use search_code only for a specific unseen symbol or dependency that the target read proves necessary.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Before editing UI, discover and read the backend route/service/store files (backend/src/application/ticket-crud-service.js, backend/src/transport/http/forge-v1-router.js, backend tests). You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
      ]
    : [
        `Allowed prefixes are ${allowedJson}. Select relevant files via discovery (select_code_graph_candidates). You may modify any file inside those prefixes if the ticket requires it.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Discover and read the backend route/service/store files and backend tests. You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
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
    "Code documentation rule: when creating a new file, add a concise summary comment at the top. When creating a new function, add a concise summary comment immediately before its definition. Summaries state purpose only and must not repeat obvious line-by-line behavior.",
    // Budget discipline: exploration must end and the run must finish within
    // the gateway wall-clock timeout. Past runs died exploring (15+ searches)
    // and timed out before edit_diff/commit. The budget comes from the ticket
    // complexity classification so simple tickets are not over-provisioned.
    `Budget discipline: you have a hard wall-clock deadline and a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Every discovery result includes discovery_budget.remaining — start editing before it reaches 0. Simple tickets do not receive automatic discovery escalation. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    "Search discipline: select_code_graph_candidates is your map — read its candidate files first. To explore an unfamiliar file, run one kind=\"file\" search with projection=\"summary\" for its symbol map, then read targeted windows. Never search for text you are guessing at (UI labels, headings, ticket phrasing); search_code exists ONLY to verify or extend identifiers you already saw in a tool result. If a search_code call returns 0 matches, do not rephrase the same guess — read a candidate file window instead.",
    "Tool enforcement: read_file on files over 500 lines returns only a 40-line preview — always pass offset/limit windows. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Use the sha256 returned by read_file as before_checksum for write_diff/edit_diff. Never send the string \"null\"; use JSON null only when read_file reports the file does not exist and a new file is intentionally required.",
    ...(targetPath ? [`Completion gate: report_done is blocked until ${targetPath} appears in changed_paths. Any report_done that does not include the target file will fail with REPORT_SCOPE_INVALID. After editing the target, verify/run_test, then commit and report_done; do not continue with unrelated discovery or edits to bypass this gate.`] : []),
    `When the ticket is satisfied, call commit_changes with an appropriate commit message and then report_done with a concise summary. Stop after report_done.`
  ].filter((line) => line !== undefined).join("\n");
}

// buildCodexToolTestPrompt - handles buildCodexToolTestPrompt operation.
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

// sdkToolEvent - handles sdkToolEvent operation.
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

// normalizeForgeToolName - handles normalizeForgeToolName operation.
function normalizeForgeToolName(name) {
  return typeof name === "string" ? name.replace(/^mcp__forge__/, "") : null;
}

// Tool-lab runs skip classification (synthetic ticket); these are the previous
// hardcoded defaults, now also the complex-tier budget floor.
const COMPLEXITY_FALLBACK = Object.freeze({ effort: "medium", discovery_budget: 8, max_turns: 40, thinking: { type: "enabled", budgetTokens: 4096 } });
// diagnosticValue - handles diagnosticValue operation.
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

// buildToolTicketPrompt - handles buildToolTicketPrompt operation.
function buildToolTicketPrompt(ticket, targetPath, allowedPrefixes, complexity) {
  const acceptance = (ticket?.acceptance_criteria ?? []).map((item) => `- ${item}`).join("\n");
  const allowedJson = JSON.stringify(allowedPrefixes);
  const backendRequired = isBackendTicket(ticket);
  const instructions = targetPath
    ? [
        `Primary target is ${JSON.stringify(targetPath)}; it is inside allowed prefixes ${allowedJson}. You may modify additional files inside those prefixes if the ticket requires it. Because the target path is explicit, skip select_code_graph_candidates and read the target directly; use search_code only for a specific unseen symbol or dependency that the target read proves necessary.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Before editing UI, discover and read the backend route/service/store files (backend/src/application/ticket-crud-service.js, backend/src/transport/http/forge-v1-router.js, backend tests). You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
      ]
    : [
        `Allowed prefixes are ${allowedJson}. Select relevant files via discovery (select_code_graph_candidates). You may modify any file inside those prefixes if the ticket requires it.`,
        `Discovery convergence rule: identify the target file/symbol first, then read only the minimum surrounding context needed to edit safely. Call select_code_graph_candidates or search_code ONLY to locate a file or identifier you have not yet seen in a prior tool result — do not re-search a path already returned, and do not run verification searches before the first edit. Once the target and its relevant context are identified, begin edit_diff or write_diff on the next turn. Every discovery result includes discovery_budget.remaining; respect it and start editing before it reaches 0.`,
        ...(backendRequired ? ["Backend requirement: this ticket has explicit backend acceptance criteria. Discover and read the backend route/service/store files and backend tests. You must modify or verify a backend implementation file and cover it with tests; do not call report_done unless a backend file appears in changed_paths."] : [])
      ];
  return [
    "Complete the following ticket using Forge tools only; do not use built-in shell, file, patch, or search tools.",
    "",
    `Ticket ${ticket?.id ?? ""}: ${ticket?.title ?? ""}`,
    `Objective: ${ticket?.objective ?? ""}`,
    ...(acceptance ? ["Acceptance criteria:", acceptance] : []),
    "",
    ...instructions,
    `Budget discipline: you have a hard turn limit and a discovery budget of ${complexity.discovery_budget} exploration calls. The next action after identifying the target and relevant context is edit_diff or write_diff; do not spend the full budget by default. Every discovery result includes discovery_budget.remaining — start editing before it reaches 0. Simple tickets do not receive automatic discovery escalation. Re-read nothing you already read; prefer edit_diff with an exact anchor over re-reading whole files. Do not run run_test before at least one edit_diff/write_diff succeeded.`,
    "Search discipline: select_code_graph_candidates is your map — read its candidate files first. Never search for text you are guessing at (UI labels, headings, ticket phrasing); search_code exists ONLY to verify or extend identifiers you already saw in a tool result. If a search_code call returns 0 matches, do not rephrase the same guess — read a candidate file window instead.",
    "Tool enforcement: read_file on files over 500 lines returns only a 40-line preview — always pass offset/limit windows. Exploration that yields no new information 3 times in a row is refused by the tool — act on what you have.",
    "Use the checksum returned by read_file as before_checksum for write_diff/edit_diff; never send the string \"null\". Use JSON null only when intentionally creating a new file.",
    "For an existing file, use edit_diff with a small exact anchor and replacement. Use write_diff only for a new file or an existing file no larger than 8 KB. If write_diff returns DESTRUCTIVE_OVERWRITE or CONTENT_TOO_LARGE, retry with edit_diff; do not stop or report done.",
    "If a governed tool call fails, fix the inputs and retry — do not continue with write_diff/commit_changes on an unknown target.",
    "Mandatory completion sequence: when the ticket is satisfied, call commit_changes with an appropriate commit message AND THEN call report_done with a concise summary. report_done is the only valid final action — never end your turn with a text-only summary, and never stop before report_done succeeds. If report_done fails, fix the reason and call it again until it succeeds.",
  ].join("\n");
}

// buildToolTestPrompt - handles buildToolTestPrompt operation.
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

// assertTicketExecutionCompleted - handles assertTicketExecutionCompleted operation.
function assertTicketExecutionCompleted(toolEvents, { labMode = false, missingCode = "TOOL_EXECUTION_FAILED" } = {}) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) throw Object.assign(new ConfigurationError("Agent did not expose Forge tool calls to the session."), { code: missingCode });
  const successful = toolEvents.filter((event) => event.status !== "failed");
  const names = successful.map((event) => event.name ?? event.tool);
  const failedReport = [...toolEvents].reverse().find((event) => (event.name ?? event.tool) === "report_done" && event.status === "failed");
  if (!names.includes("report_done")) {
    if (failedReport) {
      const code = failedReport.error_code ?? failedReport.error?.code ?? "REPORT_FAILED";
      const message = failedReport.error?.message ?? `Agent completion report failed (${code}).`;
      throw Object.assign(new ConfigurationError(message), { code });
    }
    throw Object.assign(new ConfigurationError("Agent ended without recording a completion report."), { code: "AGENT_REPORT_MISSING", tool: "report_done" });
  }
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
    throw Object.assign(new ConfigurationError("Agent ended without applying and committing ticket changes."), { code: "AGENT_CHANGES_MISSING", tool: applied ? "commit_changes" : "write_diff" });
  }
}

// collectToolCalls - handles collectToolCalls operation.
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

// extractToolEvents - handles extractToolEvents operation.
function extractToolEvents(message) {
  const blocks = [message?.content, message?.message?.content, message?.message, message].flatMap((value) => Array.isArray(value) ? value : [value]);
  return blocks
    .filter((item) => item?.type === "tool_use" || item?.type === "tool_result")
    .map((item) => ({ type: item.type, id: item.id ?? item.tool_use_id ?? null, is_error: item.is_error === true, error_code: normalizeToolErrorCode(item), name: normalizeForgeToolName(item.name ?? item.tool_name), tool_name: item.name ?? item.tool_name ?? null }));
}

// normalizeToolErrorCode - handles normalizeToolErrorCode operation.
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

// extractText - handles extractText operation.
function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  return Object.entries(value).flatMap(([key, item]) => ["message", "content", "output"].includes(key) ? extractText(item) : []);
}

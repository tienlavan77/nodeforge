// Streams owner conversations through the SDK selected by the agent profile.
import { buildArchitectureConversationMemory, formatArchitectureConversationMemory } from "./architecture-conversation-memory.js";
import { ownerToolMode, ownerBuiltinOptions, emitOwnerBuiltinActivity, codexBuiltinActivity } from "./owner-builtin-tools.js";
import { createLookupSchemaTool, lookupSchemaDefinition } from "../tools/discovery/lookup-schema-tool.js";
import { agentRoleGuidance } from "../modules/governance/agent-role-guidance.js";
import { statePath } from "../infrastructure/filesystem/forge-paths.js";
import { ConfigurationError } from "../shared/errors.js";
import { createOwnerConversationTools } from "../tools/roles/owner-conversation-tools.js";
import { ownerWritePaths, ownerWritePrefixes } from "../tools/roles/owner-role-tool-policy.js";
import { createOwnerClaudeMcpTools } from "../tools/roles/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../tools/roles/claude-forge-options.js";
import { executionDigest } from "./owner-execution-checkpoint.js";
import { checkpointOwnerTools } from "./owner-execution-tools.js";
import { withSystemEngineerEvents } from "./system-engineer-sdk-events.js";
import { codexFilesystemEntries } from "../modules/agent/codex-shell-environment.js";
import { extractTurnInputTokens, formatDiscoveryCompactReceipt, formatOwnerCompactReceiptDigest, formatOwnerStructuredWorkHandoff, formatTurnBoundaryHistory, shouldRolloverOwnerSession } from "./owner-context-compaction.js";

// Builds a role-scoped SDK stream with Forge-owned discovery and persisted conversation state.
export function createOwnerSdkStream({ agentConfiguration, sdkGateways, fallbackStream, conversationStateStore, conversationMessages, executionCheckpoint, architectureCheckpoint, fileService, codeCache, codeSearch, gitService, testService, projectRoot, projectLogger, delegateSubagentExecutor }) {
  if (typeof agentConfiguration?.getById !== "function" || typeof fallbackStream !== "function") throw new ConfigurationError("Owner SDK stream requires profiles and a fallback stream.");
  const checkpointStores = { system_engineer: executionCheckpoint, architecture_manager: architectureCheckpoint };
  const activeConversations = new Set();
  const controllers = new Map();
  // Remembers only rulebooks delivered to a retained provider session; fresh
  // sessions and process restarts receive the full instructions again.
  const deliveredGuidance = new Map();
  // Stops the active owner conversation turn when the owner confirms a pause.
  stream.pause = (conversationId) => {
    const controller = controllers.get(conversationId);
    if (!controller) return false;
    controller.abort(Object.assign(new Error("Owner conversation execution paused by owner."), { code: "EXECUTION_PAUSED" }));
    return true;
  };
  stream.isActive = (conversationId) => activeConversations.has(conversationId);
  return stream;

  // Selects an SDK by profile provider and returns its live text to the owner conversation.
  async function* stream({ agentId, payload, correlationId, conversationId, eventSink }) {
    const profile = agentConfiguration.getById(agentId);
    const sdk = withSystemEngineerEvents(sdkGateways?.[profile?.provider], { profile, conversationId, linkedConversationId: payload.linked_conversation_id ?? null, correlationId, eventSink,
      contentType: payload.response_content_type === "text/markdown" ? "text/markdown" : "text/plain" });
    projectLogger?.({ event_name: "owner.sdk_route", level: "info", status: "started", message: "Owner chat request reached SDK router.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile?.role ?? null, provider: profile?.provider ?? null, sdk_available: typeof sdk?.execute === "function" } });
    if (!(["architecture_manager", "system_engineer", "sprint_leader", "coder", "reviewer", "linguist"].includes(profile?.role))) { yield* fallbackStream({ agentId, payload, correlationId, eventSink }); return; }
    if (typeof sdk?.execute !== "function") throw new ConfigurationError(`No SDK conversation adapter is configured for provider ${profile.provider}.`);
    if (!["thread", "history"].includes(sdk.conversationMode)) throw new ConfigurationError(`SDK conversation adapter has no supported state mode for provider ${profile.provider}.`);
    if (typeof conversationId !== "string" || !conversationId) throw new ConfigurationError("Owner SDK conversation ID is required.");
    if (activeConversations.has(conversationId)) throw new ConfigurationError("This conversation already has an active agent turn.");
    activeConversations.add(conversationId);
    const systemEngineer = profile.role === "system_engineer";
    const controller = new AbortController();
    controllers.set(conversationId, controller);
    const checkpointStore = profile.role === "architecture_manager" && payload.planning_input_only === true && payload.handoff_execution !== true ? undefined : checkpointStores[profile.role];
    let checkpoint;
    let toolMode = "forge";
    let heartbeat;
    let execution;
    let sessionWrite = Promise.resolve();
    try {
      if (!payload.continue_execution) toolMode = ownerToolMode(profile, null, false);
      if (checkpointStore) {
        if (checkpointStore.role !== profile.role) throw new ConfigurationError("Owner execution checkpoint role does not match the agent profile.");
        checkpoint = await checkpointStore.start({ conversationId, executionId: correlationId, messageId: payload.source_message_id ?? payload.message_id, provider: profile.provider, toolMode, promptHash: executionDigest(payload.text), resumeOf: payload.resume_of ?? null, continueAttempt: payload.continue_execution === true });
        if (checkpoint.role !== profile.role) throw new ConfigurationError("Owner execution checkpoint role does not match the agent profile.");
        controllers.set(conversationId, controller);
        heartbeat = setInterval(() => { void checkpointStore.patch(conversationId, correlationId, {}).catch((error) => projectLogger?.({ event_name: "owner.execution_heartbeat_failed", level: "error", message: error.message, task_id: correlationId })); }, 10_000);
        heartbeat.unref?.();
      }
      toolMode = ownerToolMode(profile, checkpoint, payload.continue_execution === true);
      if (checkpoint && !checkpoint.tool_mode) checkpoint = await checkpointStore.patch(conversationId, correlationId, { tool_mode: toolMode, checkpoint_kind: toolMode === "builtin" ? "sdk_session" : "forge_receipts" });
      const builtin = systemEngineer && toolMode === "builtin";
      const state = await conversationStateStore?.create?.({ conversationId, taskId: conversationId, agentId });
      if (state?.agent_id && state.agent_id !== agentId) throw new ConfigurationError("Owner SDK conversation belongs to a different agent.");
      const sameProvider = state?.sdk_provider === profile.provider;
      const retainedState = sameProvider && (state?.sdk_tool_mode ?? "forge") === toolMode ? state : {};
      const measuredContextTokens = await sdk.inspectContext?.({ agentId, conversationId, sessionId: checkpoint?.provider_thread_id ?? retainedState.sdk_thread_id, cwd: projectRoot });
      if (Number.isFinite(measuredContextTokens) && measuredContextTokens > 0) {
        retainedState.last_turn_input_tokens = measuredContextTokens;
        await conversationStateStore?.update?.(conversationId, { last_turn_input_tokens: measuredContextTokens });
      }
      const storedMessages = (!sameProvider || profile.role === "architecture_manager") && conversationMessages?.getByConversationId?.(conversationId);
      const rawHistory = Array.isArray(storedMessages) ? storedMessages.filter((message) => message.correlation_id !== correlationId && typeof message.payload?.text === "string").flatMap((message) => message.message_type === "owner.message" ? [{ role: "User", text: message.payload.text }] : message.message_type?.endsWith(".message.received") || message.payload?.sdk_event?.type === "conversation_turn" ? [{ role: "Assistant", text: message.payload.text }] : []).slice(profile.role === "architecture_manager" ? 0 : -8) : (state?.sdk_history ?? []);
      const filteredHistory = payload.planning_input_only === true ? rawHistory : rawHistory.filter((turn) => {
        const t = String(turn?.text ?? "").trim();
        return !t.startsWith("Architecture clarification discovery") && !t.startsWith("Architecture plan generation") && !t.startsWith("Architecture plan update") && !(turn.role === "Assistant" && t.startsWith("{") && t.endsWith("}"));
      });
      const rollover = shouldRolloverOwnerSession(retainedState, { continueExecution: payload.continue_execution === true, resumeOf: payload.resume_of ?? null, planningInputOnly: payload.planning_input_only === true, threshold: payload.compaction_token_threshold ?? 380000, incomingText: payload.text, history: Number.isFinite(measuredContextTokens) && measuredContextTokens > 0 ? [] : filteredHistory });
      const architectureMemory = profile.role === "architecture_manager" ? buildArchitectureConversationMemory(state?.architecture_conversation_memory, filteredHistory) : null;
      const planningMemoryNote = formatArchitectureConversationMemory(architectureMemory);
      if (architectureMemory) await conversationStateStore?.update?.(conversationId, { architecture_conversation_memory: architectureMemory });
      const history = rollover ? [] : filteredHistory;
      const rolloverCount = (retainedState.compaction_rollover_count ?? 0) + (rollover ? 1 : 0);
      const resumeThreadId = payload.planning_input_only === true || payload.resume_of || rollover ? null : payload.continue_execution ? checkpoint?.provider_thread_id : checkpoint?.provider_thread_id ?? retainedState.sdk_thread_id;
      if (payload.continue_execution && !rollover && !resumeThreadId) throw Object.assign(new ConfigurationError("Provider session is unavailable; choose Restart instead of Continue."), { code: "EXECUTION_SESSION_UNAVAILABLE", statusCode: 409 });
      if (rollover) {
        const compactionMode = retainedState.sdk_thread_id ? "session_rollover" : "history_rollover";
        projectLogger?.({ event_name: "owner.sdk_context_compacted", level: "info", status: "success", message: "Rolled over Owner SDK session after token threshold with compacted receipt digest.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile.role, provider: profile.provider, mode: compactionMode, previous_session_id: retainedState.sdk_thread_id ?? null, input_tokens: Number(retainedState.last_turn_input_tokens ?? 0), receipt_position: checkpoint?.last_completed_step ?? 0, compaction_rollover_count: rolloverCount } });
      }
      const recovery = payload.continue_execution || payload.resume_of;
      const receipts = checkpoint?.completed_tool_calls ?? [];
      const selectedReceipts = receipts.filter((receipt, index) => index >= receipts.length - 12 || ["commit_changes", "push_commit"].includes(receipt.tool_name));
      const compactDigest = (recovery && checkpoint) || rollover ? formatOwnerCompactReceiptDigest({ checkpoint, state: retainedState, selectedReceipts }) : "";
      const isPlanningFollowup = payload.planning_input_only === true && !String(payload.text ?? "").startsWith("Architecture clarification discovery");
      const discoveryReceiptNote = isPlanningFollowup ? formatDiscoveryCompactReceipt(state) : "";
      const resumeNotes = recovery && checkpoint && !rollover ? `\nExecution checkpoint (Compact Receipt Digest — reuse active_file_checksums as before_checksum for edit_diff/write_diff/delete_file/move_file without re-reading unchanged files): ${compactDigest}. Do not repeat completed file writes or Git operations. Inspect the workspace and continue from the next safe step.\n`
        : rollover ? formatOwnerStructuredWorkHandoff({ profile, history: filteredHistory, checkpoint, state: retainedState, selectedReceipts, compactDigest }) : "";
      const context = { task_id: correlationId, execution_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, agent_identity: { agent_id: agentId, agent_name: profile.agent_name, role: profile.role, provider: profile.provider }, planning_input_only: payload.planning_input_only === true, ...(profile.role === "system_engineer" ? {} : { allowed_write_paths: ownerWritePaths(payload.task?.candidate_files ?? []), allowed_write_prefixes: ownerWritePrefixes(profile.role) }), changed_paths: [...new Set(state?.owner_changed_paths ?? [])], project_root: projectRoot, project_wide_access: profile.role === "system_engineer" };
      const childExecutor = delegateSubagentExecutor ?? (async (task, child) => {
        const childContext = { ...context, ...child, execution_id: child.execution_id ?? `${correlationId}:sub:${task.id}`, correlation_id: child.correlation_id ?? `${correlationId}:sub:${task.id}`, capabilities: child.capabilities ?? child.tools, exploration_enabled: false, subagent_depth: child.subagent_depth ?? 1 };
        const childTools = createOwnerConversationTools({ role: profile.role, projectRoot, fileService, codeCache, codeSearch, gitService: undefined, testService: undefined, conversationStateStore: undefined, conversationId: undefined, projectLogger: () => {}, eventSink: undefined, context: childContext, readOnlyExplorer: true });
        const childForgeTools = { registry: childTools.registry, definitions: childTools.definitions, context: childContext };
        const childClaudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(childForgeTools) : null;
        const childProviderOptions = childClaudeTools
          ? createClaudeForgeOptions(childClaudeTools)
          : sdk.conversationMode === "thread" ? { sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled" } : {};
        const childSdk = sdkGateways?.[profile.provider];
        if (typeof childSdk?.execute !== "function") throw Object.assign(new ConfigurationError("No SDK child executor is configured for the parent provider."), { code: "SUBAGENT_EXECUTOR_UNAVAILABLE" });
        const result = await childSdk.execute({ agentId, agent: profile, subagentId: child.subagentId, conversationId, correlationId: child.correlation_id ?? child.execution_id, prompt: `Read-Only Explorer objective: ${task.objective}${Array.isArray(task.paths) && task.paths.length ? `\nPrioritize paths: ${task.paths.join(", ")}` : ""}`, cwd: projectRoot, abortSignal: child.abortSignal, options: { ...childProviderOptions, effort: "low", forgeTools: childForgeTools } });
        return { summary: result?.text ?? result?.response ?? "", observed_files: childContext.observed_files ?? [], subagent_usage: result?.usage ?? null };
      });
      const { definitions, registry } = builtin ? { definitions: [lookupSchemaDefinition], registry: { lookup_schema: createLookupSchemaTool({ role: profile.role }) } } : createOwnerConversationTools({ role: profile.role, projectRoot, fileService, codeCache, codeSearch, gitService, testService, conversationStateStore, conversationId, projectLogger, eventSink, context, delegateSubagentExecutor: childExecutor });
      context.capabilities = definitions.map((item) => item.name);
      if (!builtin && !definitions.length) throw new ConfigurationError(`No Forge conversation tools are available for role ${profile.role}.`);
      // Waits for the provider session checkpoint before allowing a Forge tool to execute.
      const waitForSessionReady = () => sessionWrite;
      const forgeTools = { registry: checkpoint ? checkpointOwnerTools({ registry, checkpoint: checkpointStore, conversationId, executionId: correlationId, signal: controller.signal, sessionReady: waitForSessionReady, toolContext: context }) : registry, context, definitions };
      const claudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(forgeTools) : null;
      const queue = []; let wake; let finished = false; let failure; let finalResult; let threadId;
      // Defines push function behavior for owner-sdk-stream.js.
      const push = (value) => { queue.push(value); wake?.(); wake = undefined; };
      const seenText = new Map();
      const builtinTools = [];
      const roleAllowsBuiltinWebSearch = ["system_engineer", "architecture_manager"].includes(profile.role);
      const sdkSearchAvailable = typeof sdk.builtinWebSearchAvailable === "function" ? sdk.builtinWebSearchAvailable(profile) : sdk.builtinWebSearchAvailable !== false;
      const allowBuiltinWebSearch = roleAllowsBuiltinWebSearch && sdkSearchAvailable;
      const webSearchCapabilityNote = roleAllowsBuiltinWebSearch && !allowBuiltinWebSearch ? "\nThis SDK provider does not support native web search. Do not claim to search the web; explain the limitation if the owner asks, and keep using Forge tools for project information." : "";
      const searchToolInstruction = "Use only the supplied Forge tools for repository discovery, reading, editing, checks, and Git.";
      const toolInstruction = builtin ? "You are the project System Engineer. Work directly with the supplied SDK built-in tools. Explore, edit, and verify the project autonomously. Only access project data within the project root; system binaries are for executing tools. Use lookup_schema only for response-contract reference; use native tools for all repository work. Git commit and push only when the owner requests them. Inspect existing changes before committing; do not discard unrelated work." : sdk.conversationMode === "thread" ? systemEngineer
        ? `You are the project's System Engineer. ${searchToolInstruction} ${allowBuiltinWebSearch ? "Use the built-in web search tool when external technical information is needed. Never use built-in file-change or shell tools." : "Never use SDK built-in file-change, network, or web-search tools."}`
        : allowBuiltinWebSearch ? "You are the project's Architecture Manager. Use the built-in web search tool when external technical information is needed. Use only Forge tools for project files; never use built-in command, shell, or file-change tools. Answer directly when no project file is needed."
          : "Use only the Forge tools listed in this turn. Never use built-in command_execution, file_change, or web_search tools. Answer directly when no project file is needed."
        : systemEngineer ? `You are the project's System Engineer. ${searchToolInstruction} ${allowBuiltinWebSearch ? "Use the SDK built-in web search tool when external technical information is needed. Never use built-in file-change or shell tools." : "Never use SDK built-in file-change, network, or web-search tools."}`
          : "";
      const responseFormatInstruction = payload.response_content_type === "text/markdown" ? "The owner explicitly selected Markdown for this reply. Format this response as Markdown; do not change the declared content type." : "";
      const isClarificationDiscovery = payload.planning_input_only === true && String(payload.text ?? "").startsWith("Architecture clarification discovery");
      const fileToolInstruction = isClarificationDiscovery
        ? "This is a backend-owned planning command returning structured JSON for clarification discovery (NOT plan generation). Do NOT call lookup_schema for architecture_plan and do NOT draft a plan yet. Use read-only Forge tools only if needed to check whether any owner-level policy decision is unresolved, then return ONLY one valid JSON object {\"questions\":[...]} or {\"questions\":[]} with no surrounding prose."
        : payload.planning_input_only === true ? "This is a backend-owned planning command. Use only the supplied read-only Forge tools for repository discovery (including delegate_subagent for up to 3 parallel read-only explorer tasks across independent modules) and call lookup_schema({\"schema_id\":\"architecture_manager.architecture_plan.v1\"}) to inspect the Architecture Plan JSON contract. Return exactly the format requested by the command: structured JSON for clarification discovery, canonical Architecture Plan JSON for plan generation, or an RFC 7396 JSON merge patch for plan updates. Never return Markdown plan files or create, edit, delete, or persist files. NodeForge validates and saves the result after your response; do not claim that it has been saved." : builtin ? `Use SDK native search and file tools to inspect relevant code, then implement the request. Run only tests and checks relevant to the changed code and the owner's acceptance criteria, using the narrowest suitable commands. Do not run the full project suite unless the owner requests it or a required verification gate explicitly mandates it. This execution has SDK session recovery, not Forge operation receipts. On continuation inspect the workspace before repeating mutations or Git commands.` : systemEngineer
        ? `This is direct project engineering, not a ticket. You have full read, create, edit and delete access to .forge/ within this project. Inspect internal state using search_tree({path: "${statePath()}/<relevant-directory>"}) or search_text with paths:["${statePath()}/<relevant-directory>"]; narrow runtime searches to the relevant directory instead of searching all logs and caches; use delete_file with the current checksum to remove a file. Stay inside the project root. Before searching, translate the owner's request into concise English code/business terms. Use the Forge search_text tool first with those English terms to locate matching implementation and tests; try a small number of relevant English identifiers or synonyms if needed. Use search_tree/list_files when directory or filename discovery is needed. When investigating 2 or more independent files/subsystems, call delegate_subagent({tasks:[{id,objective,paths}]}) (up to 3 parallel read-only tasks) in the same turn batch alongside your own direct read_file/Read/edit_diff on the primary target file; never delegate a single-file read or passively wait on subagents. Use read_file({path}) for metadata, then Read({file_path,symbol}) for code selected from read_file code_graph/symbol_map; Read({file_path,start_line,end_line}) only for .md documents, at most 80 physical lines. Code reads return the entire selected symbol without extra lines. read_file accepts path only. Use write_diff for new files and edit_diff for existing files with the exact checksum. Run checks with one run_check call, specifying the narrowest test or lint command that covers changed files. Do not run the full project suite unless requested or required. run_check returns the final result directly. Inspect git_status and git_diff before commit_changes. Then push only the returned commit SHA with push_commit.`
        : profile.role !== "architecture_manager" ? `You are the NodeForge ${profile.role} in an Owner conversation. Use only the supplied read-only Forge tools (including delegate_subagent for up to 3 parallel read-only exploration tasks across independent modules). Ticket execution and its mutation, verification and Git tools belong to the separate governed ticket flow. Report only observed results.`
        : `${allowBuiltinWebSearch ? "Use the SDK built-in web search for external architecture references when useful. " : ""}IMPORTANT: This turn is normal interactive chat with the human Project Owner, streamed directly to the UI — it is NOT a backend-owned planning command (planning_input_only is false). Always respond in clear, human-readable natural language and Markdown; NEVER output a raw architecture_plan.v1 JSON object or JSON dump in normal chat, and do NOT call lookup_schema({"schema_id":"architecture_manager.architecture_plan.v1"}) unless Node explicitly invokes a planning_input_only command. Use Forge search_tree for directory structure, list_files for file lists, search_text for content search, and delegate_subagent({tasks:[{id,objective,paths}]}) (up to 3 parallel read-only tasks) when exploring multiple independent modules concurrently with your own direct inspection. read_file({path}) accepts path only and returns source metadata and symbol map; Markdown includes up to 250 lines. Read({file_path,symbol}) for code selected from read_file code_graph/symbol_map; Read({file_path,start_line,end_line}) only for .md documents returns source from Code Cache, at most 80 physical lines. Never pass offset, limit or symbol to read_file. Use the exact sha256 from read_file as before_checksum for edit_diff or write_diff; never guess it. For architecture writing, use write_diff or edit_diff only within ARCHITECTURE.md, docs/, Skills/, or workflows/. Delete only files in workflows/ with delete_file after reading their checksum. Other files are read-only. Architecture plans are created and updated when the Owner issues a create-plan trigger; never write Markdown plan files or suggest /plan <file.md>. Report tool results once, accurately.`;
      const sourceDiscoveryInstruction = builtin ? "" : "Source discovery: read_file({path}) returns metadata, symbol_map and code_graph (imports, imported_by, calls), without source content for code files. Inspect these before reading code; use graph relationships to select relevant files and prefer Read({file_path,symbol}) for the specific behavior under investigation. Code requires a symbol from prior read_file metadata; start_line/end_line is allowed only for .md documents, at most 80 physical lines per call. Code line windows are forbidden. Return the complete selected symbol, regardless of its line count, without including lines outside its bounds. Do not concatenate adjacent windows to reconstruct an entire source file or use broad search_text patterns to dump source. An empty graph with index_status stale or unavailable is missing evidence, not proof of no dependencies. Reuse retained discovery evidence instead of repeating reads. For multi-file or cross-module exploration, use delegate_subagent({tasks:[{id,objective,paths}]}) (up to 3 parallel read-only tasks) concurrently alongside your own direct read_file/Read/edit_diff on the primary target file; files observed by subagents automatically register read_file metadata receipts and checksums on the parent context so you can call Read({file_path,symbol}) or edit_diff directly without re-reading unchanged files.";
      const claudeOptions = claudeTools ? {
        ...createClaudeForgeOptions({ ...claudeTools, allowedTools: [...claudeTools.allowedTools, ...(allowBuiltinWebSearch ? ["WebSearch"] : [])] }),
        ...(allowBuiltinWebSearch ? { tools: ["WebSearch"] } : {})
      } : {};
      const codexOptions = sdk.conversationMode === "thread" ? {
        sandboxMode: "read-only",
        approvalPolicy: "on-request", networkAccessEnabled: allowBuiltinWebSearch, webSearchMode: allowBuiltinWebSearch ? "live" : "disabled",
        ...(systemEngineer ? { config: { default_permissions: "audit" }, configOverrides: [codexFilesystemPolicy(projectRoot)] } : {})
      } : {};
      // Saves the provider session immediately so an interrupted execution can resume its thread.
      const nativeActivity = (event) => emitOwnerBuiltinActivity({ profile, conversationId, correlationId, eventSink, projectLogger }, event);
      let nativeTextStreamed = false;
      const nativeOptions = builtin ? ownerBuiltinOptions(profile, projectRoot) : {};
      const builtinOptions = builtin ? { ...nativeOptions, ...(claudeTools ? { mcpServers: claudeTools.mcpServers,
        allowedTools: [...nativeOptions.allowedTools, ...claudeTools.allowedTools] } : {}), includePartialMessages: true, onBuiltinToolEvent: nativeActivity, onTextDelta: (text) => { nativeTextStreamed = true; push({ text }); } } : {};
      projectLogger?.({ event_name: "owner.sdk_request_started", level: "info", status: "started", message: payload.continue_execution ? `Owner SDK Continue started after checkpoint step ${checkpoint?.last_completed_step ?? 0}.` : payload.resume_of ? "Owner SDK Restart started in a new provider session." : "Owner SDK new request started.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile.role, provider: profile.provider, conversation_mode: sdk.conversationMode, recovery_mode: payload.continue_execution ? "continue" : payload.resume_of ? "restart" : "new", provider_session_resumed: Boolean(resumeThreadId), checkpoint_step: checkpoint?.last_completed_step ?? 0, tool_mode: toolMode, forge_tools: definitions.map((item) => item.name), builtins: builtin ? (profile.provider === "codex" ? ["command_execution", "file_change", "web_search"] : builtinOptions.tools) : builtinTools } });
      // Defines onProviderSessionReady function behavior for owner-sdk-stream.js.
      const onProviderSessionReady = (id) => {
        if (typeof id !== "string" || !id) return;
        threadId = id;
        if (!checkpoint) return;
        sessionWrite = Promise.all([sessionWrite, checkpointStore.patch(conversationId, correlationId, { provider_thread_id: id }), conversationStateStore?.update?.(conversationId, { sdk_provider: profile.provider, sdk_tool_mode: toolMode, sdk_thread_id: id })]).catch((error) => { failure = error; controller?.abort(error); });
      };
      const guidanceKey = JSON.stringify([conversationId, agentId, profile.provider, profile.role, toolMode]);
      const previousGuidance = deliveredGuidance.get(guidanceKey);
      const roleGuidance = agentRoleGuidance(profile.role, { previousHash: resumeThreadId && previousGuidance?.threadId === resumeThreadId ? previousGuidance.sha256 : undefined });
      execution = sdk.execute({ agentId, agent: profile, conversationId, correlationId, cwd: projectRoot, abortSignal: controller?.signal, prompt: `${roleGuidance.prompt}\n\n${toolInstruction}${responseFormatInstruction}${webSearchCapabilityNote}${resumeNotes}${!resumeThreadId ? planningMemoryNote : ""}\n${!resumeThreadId && !payload.resume_of && !rollover ? formatTurnBoundaryHistory(history) : ""}\n${payload.continue_execution ? "Continue the interrupted request from this provider session and checkpoint. Do not restart the original request or repeat completed steps." : `User: ${payload.text}${discoveryReceiptNote}`}\n\n${fileToolInstruction}\n${sourceDiscoveryInstruction}`, options: { ...(forgeTools ? { forgeTools } : {}), builtinWebSearch: allowBuiltinWebSearch, ...claudeOptions, ...codexOptions, ...builtinOptions }, ...(checkpoint && sdk.conversationMode === "history" && ["claude", "anthropic"].includes(profile.provider) ? { resumeSessionId: resumeThreadId ?? undefined, onSessionReady: onProviderSessionReady } : {}), ...(sdk.conversationMode === "thread" ? { resumeThreadId: resumeThreadId ?? undefined, onSessionReady: onProviderSessionReady, onEvent: async (event) => { if (!builtin && event.type === "item.started" && isUnapprovedCodexTool(event.item, definitions, allowBuiltinWebSearch)) { const tool = `codex_builtin:${event.item?.type ?? "unknown"}`; projectLogger?.({ event_name: "owner.tool_call", level: "error", status: "failed", message: "Owner SDK built-in tool was blocked.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", error_code: "TOOL_FORBIDDEN", payload: { tool, agent_id: agentId, agent_name: profile.agent_name, provider: profile.provider } }); throw Object.assign(new ConfigurationError(`Owner SDK conversation attempted an unapproved built-in tool: ${event.item?.type ?? "unknown"}.`), { code: "TOOL_FORBIDDEN" }); } if (builtin) { const activity = codexBuiltinActivity(event); if (activity) nativeActivity(activity); } if (["item.started", "item.completed"].includes(event.type) && event.item?.type === "mcp_tool_call" && event.item.server === "forge" && definitions.some(({ name }) => name === event.item.tool)) { const failed = event.type === "item.completed" && (event.item.status === "failed" || event.item.error); const started = event.type === "item.started"; eventSink?.({ event_type: "agent.activity", task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { agent_id: agentId, correlation_id: correlationId, activity_type: started ? "tool_started" : failed ? "tool_failed" : "tool_completed", status: started ? "working" : failed ? "failed" : "success", summary: started ? `Running Forge tool: ${event.item.tool}` : `Forge tool ${event.item.tool} ${failed ? "failed" : "succeeded"}`, tool_name: event.item.tool } }); } if ((event.type !== "item.updated" && event.type !== "item.completed") || event.item?.type !== "agent_message") return; const current = event.item.text ?? ""; const previous = seenText.get(event.item.id) ?? ""; seenText.set(event.item.id, current); if (current.startsWith(previous) && current.length > previous.length) push({ text: current.slice(previous.length) }); else if (current !== previous && event.type === "item.completed") push({ text: current }); } } : {}) }).then((result) => { finalResult = result; }, (error) => { failure = error; projectLogger?.({ event_name: "owner.sdk_failed", level: "error", status: "failed", message: "Owner SDK conversation failed.", task_id: correlationId, correlation_id: correlationId, source: "owner-sdk-stream", error_code: error.code ?? "OWNER_SDK_FAILED", payload: { agent_id: agentId, provider: profile.provider } }); }).finally(() => { finished = true; wake?.(); wake = undefined; });
      while (!finished || queue.length) { if (!queue.length) await new Promise((resolve) => { wake = resolve; }); while (queue.length) yield queue.shift(); }
      await execution;
      await sessionWrite;
      if (failure) throw failure;
      if (controller?.signal.aborted) throw controller.signal.reason;
      const resolvedThreadId = threadId ?? finalResult?.session_id ?? finalResult?.thread_id ?? null;
      if (resolvedThreadId) {
        deliveredGuidance.delete(guidanceKey);
        deliveredGuidance.set(guidanceKey, { threadId: resolvedThreadId, sha256: roleGuidance.sha256 });
        if (deliveredGuidance.size > 256) deliveredGuidance.delete(deliveredGuidance.keys().next().value);
      }
      const turnInputTokens = extractTurnInputTokens(finalResult);
      const subagentUsage = Number(state?.subagent_usage ?? 0);
      projectLogger?.({ event_name: "owner.sdk_request_completed", level: "info", status: "success", message: "Owner SDK request completed.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, response_chars: finalResult?.text?.length ?? 0, thread_id: resolvedThreadId, ...(turnInputTokens > 0 ? { input_tokens: turnInputTokens } : {}), ...(subagentUsage > 0 ? { subagent_usage: subagentUsage } : {}) } });
      if (finalResult?.text && payload.planning_input_only !== true) await conversationStateStore?.update?.(conversationId, { sdk_provider: profile.provider, sdk_tool_mode: toolMode, sdk_thread_id: sdk.conversationMode === "thread" || (Boolean(checkpoint) && ["claude", "anthropic"].includes(profile.provider)) ? resolvedThreadId : null, last_turn_input_tokens: turnInputTokens, ...(rolloverCount ? { compaction_rollover_count: rolloverCount } : {}), ...(architectureMemory ? { architecture_conversation_memory: buildArchitectureConversationMemory(architectureMemory, [{ role: "User", text: payload.text }, { role: "Assistant", text: finalResult.text }]) } : {}), sdk_history: [...history, { role: "User", text: payload.text }, { role: "Assistant", text: finalResult.text }].slice(-8) });
      if (checkpoint && !finalResult?.text?.trim()) throw new ConfigurationError("System Engineer execution ended without a response.");
      const handoffCompleted = finalResult?.status === "completed" && (finalResult?.turn_completed === undefined || finalResult.turn_completed === true);
      if (payload.handoff_execution === true && !handoffCompleted) throw Object.assign(new ConfigurationError("Handoff SDK turn has no successful terminal receipt."), { code: "HANDOFF_EXECUTION_UNKNOWN" });
      const handoffTerminal = { execution_id: correlationId, terminal_status: "completed", result_evidence: { sdk_status: finalResult?.status, turn_completed: finalResult?.turn_completed ?? null, provider_session_id: resolvedThreadId }, read_only_enforced: profile.role === "reviewer" && toolMode === "forge", ...(payload.handoff_execution === true ? { changed_paths: [...new Set(checkpoint?.changed_paths ?? [])].filter((path) => typeof path === "string" && path) } : {}) };
      if (checkpoint) await checkpointStore.patch(conversationId, correlationId, { status: "completed", completed_at: new Date().toISOString(), ...(payload.handoff_execution === true ? { handoff_result: { ...handoffTerminal, text: finalResult?.text ?? "" } } : {}) });
      if (sdk.conversationMode === "history" && !nativeTextStreamed && finalResult?.text) yield { text: finalResult.text };
      if (sdk.conversationMode === "thread" && !seenText.size && finalResult?.text) yield { text: finalResult.text };
      if (finalResult?.usage) yield { usage: finalResult.usage };
      // A handoff terminal receipt represents the SDK's own completed turn, not stream exhaustion or partial text.
      if (payload.handoff_execution === true) yield { handoff_terminal: handoffTerminal };
    } catch (error) {
      if (checkpoint) {
        const current = await checkpointStore.load(conversationId, correlationId);
        if (current?.status === "running") await checkpointStore.patch(conversationId, correlationId, { status: current.pending_tool_calls.some((step) => step.mutating) ? "manual_required" : "interrupted", next_action_hint: error.code === "EXECUTION_PAUSED" ? "Paused by owner." : "Execution stopped; reconcile workspace before continuing." });
        const persisted = await checkpointStore.load(conversationId, correlationId);
        if (error.code !== "EXECUTION_PAUSED" && ["interrupted", "manual_required"].includes(persisted?.status)) {
          eventSink?.({ event_type: "agent.activity", task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { agent_id: agentId, correlation_id: correlationId, activity_type: "failed", status: "failed", summary: ownerFailureSummary(error), error_code: ownerFailureCode(error) } });
        }
        if (error.code === "EXECUTION_PAUSED" && ["interrupted", "manual_required"].includes(persisted?.status)) {
          eventSink?.({ event_type: "agent.activity", task_id: correlationId, conversation_id: conversationId, correlation_id: correlationId, timestamp: new Date().toISOString(), payload: { agent_id: agentId, correlation_id: correlationId, activity_type: "paused", status: "paused", summary: "Paused by owner.", error_code: "EXECUTION_PAUSED" } });
        }
      }
      throw error;
    } finally {
      clearInterval(heartbeat);
      if (checkpoint) {
        try { if (execution) await execution; await checkpointStore.markStopped(conversationId, correlationId); }
        catch (error) { projectLogger?.({ event_name: "owner.execution_stop_evidence_failed", level: "error", message: error.message, task_id: correlationId }); }
      }
      controllers.delete(conversationId);
      activeConversations.delete(conversationId);
    }
  }
}

// Maps provider failures to bounded public status text without leaking upstream response details.
function ownerFailureCode(error) {
  const status = Number(error?.status ?? error?.statusCode);
  if ([429, 404, 500].includes(status)) return `PROVIDER_HTTP_${status}`;
  if (error?.code === "ETIMEDOUT" || error?.code === "TIMEOUT") return "PROVIDER_TIMEOUT";
  return "PROVIDER_TRANSPORT";
}

// Provides a safe interruption summary for the owner activity stream.
function ownerFailureSummary(error) {
  const code = ownerFailureCode(error);
  if (code.startsWith("PROVIDER_HTTP_")) return `Provider request failed (${code.slice(-3)}).`;
  if (code === "PROVIDER_TIMEOUT") return "Provider request timed out.";
  return "Provider request could not be completed.";
}

// Constrains Codex shell file access to the project while preserving read access to system binaries.
function codexFilesystemPolicy(projectRoot) {
  return `permissions.audit.filesystem={${codexFilesystemEntries(projectRoot, "read").join(",")}}`;
}

// Allows only the explicitly enabled Codex web search alongside registered Forge MCP tools.
function isUnapprovedCodexTool(item, definitions, allowWebSearch = false) {
  if (!item || typeof item.type !== "string") return false;
  if (item.type === "command_execution") return true;
  if (["file_change", "local_shell_call", "image_view"].includes(item.type) || (item.type === "web_search" && !allowWebSearch)) return true;
  if (item.type !== "mcp_tool_call") return false;
  return item.server !== "forge" || !definitions.some(({ name }) => name === item.tool);
}

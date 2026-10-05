// Streams owner conversations through the SDK selected by the agent profile.
import { ConfigurationError } from "../shared/errors.js";
import { createOwnerConversationTools } from "../tools/owner-conversation-tools.js";
import { ownerWritePaths, ownerWritePrefixes } from "../tools/owner-role-tool-policy.js";
import { createOwnerClaudeMcpTools } from "../tools/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../tools/claude-forge-options.js";
import { createOwnerBuiltinSearchShell } from "../tools/owner-builtin-search-shell.js";
import { isAbsolute, resolve, sep } from "node:path";

// Builds a role-scoped SDK stream with Forge-owned discovery and persisted conversation state.
export function createOwnerSdkStream({ agentConfiguration, sdkGateways, fallbackStream, conversationStateStore, conversationMessages, fileService, codeCache, codeSearch, gitService, testService, projectRoot, projectLogger }) {
  if (typeof agentConfiguration?.getById !== "function" || typeof fallbackStream !== "function") throw new ConfigurationError("Owner SDK stream requires profiles and a fallback stream.");
  const activeConversations = new Set();
  return stream;

  // Selects an SDK by profile provider and returns its live text to the owner conversation.
  async function* stream({ agentId, payload, correlationId, conversationId, eventSink }) {
    const profile = agentConfiguration.getById(agentId);
    const sdk = sdkGateways?.[profile?.provider];
    projectLogger?.({ event_name: "owner.sdk_route", level: "info", status: "started", message: "Owner chat request reached SDK router.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile?.role ?? null, provider: profile?.provider ?? null, sdk_available: typeof sdk?.execute === "function" } });
    if (!(["architecture_manager", "system_engineer"].includes(profile?.role))) { yield* fallbackStream({ agentId, payload, correlationId, eventSink }); return; }
    if (typeof sdk?.execute !== "function") throw new ConfigurationError(`No SDK conversation adapter is configured for provider ${profile.provider}.`);
    if (!["thread", "history"].includes(sdk.conversationMode)) throw new ConfigurationError(`SDK conversation adapter has no supported state mode for provider ${profile.provider}.`);
    if (typeof conversationId !== "string" || !conversationId) throw new ConfigurationError("Owner SDK conversation ID is required.");
    if (activeConversations.has(conversationId)) throw new ConfigurationError("This conversation already has an active agent turn.");
    activeConversations.add(conversationId);
    try {
      const state = await conversationStateStore?.create?.({ conversationId, taskId: conversationId, agentId });
      if (state?.agent_id && state.agent_id !== agentId) throw new ConfigurationError("Owner SDK conversation belongs to a different agent.");
      const sameProvider = state?.sdk_provider === profile.provider;
      const retainedState = sameProvider ? state : {};
      const storedMessages = !sameProvider && conversationMessages?.getByConversationId?.(conversationId);
      const history = Array.isArray(storedMessages) ? storedMessages.filter((message) => message.correlation_id !== correlationId && typeof message.payload?.text === "string").flatMap((message) => message.message_type === "owner.message" ? [{ role: "User", text: message.payload.text }] : message.message_type?.endsWith(".message.received") ? [{ role: "Assistant", text: message.payload.text }] : []).slice(-8) : (state?.sdk_history ?? []);
      const resumeThreadId = sdk.conversationMode === "thread" ? retainedState.sdk_thread_id : undefined;
      const context = { task_id: correlationId, execution_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, agent_identity: { agent_id: agentId, agent_name: profile.agent_name, role: profile.role, provider: profile.provider }, ...(profile.role === "system_engineer" ? {} : { allowed_write_paths: ownerWritePaths(payload.task?.candidate_files ?? []), allowed_write_prefixes: ownerWritePrefixes(profile.role) }), changed_paths: [...new Set(state?.owner_changed_paths ?? [])], project_root: projectRoot, project_wide_access: profile.role === "system_engineer" };
      const { definitions, registry } = createOwnerConversationTools({ role: profile.role, projectRoot, fileService, codeCache, codeSearch, gitService, testService, conversationStateStore, conversationId, projectLogger, context });
      context.capabilities = definitions.map((item) => item.name);
      if (!definitions.length) throw new ConfigurationError(`No Forge conversation tools are available for role ${profile.role}.`);
      const forgeTools = { registry, context, definitions };
      const claudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(forgeTools) : null;
      const queue = []; let wake; let finished = false; let failure; let finalResult; let threadId;
      const push = (value) => { queue.push(value); wake?.(); wake = undefined; };
      const seenText = new Map();
      const systemEngineer = profile.role === "system_engineer";
      const usesClaudeSearch = systemEngineer && ["claude", "anthropic"].includes(profile.provider);
      const usesCodexSearch = systemEngineer && profile.provider === "codex";
      const usesOpenAiSearch = systemEngineer && profile.provider === "openai";
      const builtinTools = usesClaudeSearch ? ["Glob", "Grep"] : usesCodexSearch ? ["command_execution:rg/find"] : usesOpenAiSearch ? ["shell:rg/find"] : [];
      const searchToolInstruction = usesClaudeSearch ? "Use Claude built-in Glob and Grep for project file/content search. Use Forge read_file and read_lines to inspect source; use Forge tools for edits, checks and Git." : usesCodexSearch ? "Use Codex command_execution only for read-only project discovery with rg/find. Use Forge read_file/read_lines to inspect source and Forge tools for edits, checks and Git." : usesOpenAiSearch ? "Use the OpenAI built-in shell tool only for read-only project discovery with rg/find. Use Forge read_file/read_lines to inspect source and Forge tools for edits, checks and Git." : "Use the supplied Forge tools for repository operations.";
      const toolInstruction = sdk.conversationMode === "thread" ? systemEngineer
        ? `You are the project's System Engineer. ${searchToolInstruction} Never use SDK built-in file-change, network, or web-search tools.`
        : "Use only the Forge tools listed in this turn. Never use built-in command_execution, file_change, or web_search tools. Answer directly when no project file is needed."
        : systemEngineer ? `You are the project's System Engineer. ${searchToolInstruction} Never use SDK built-in file-change, network, or web-search tools.`
          : "";
      const fileToolInstruction = systemEngineer
        ? `This is direct project engineering, not a ticket. Before searching, translate the owner's Vietnamese request into concise English code/business terms, then use ${usesClaudeSearch ? "Glob/Grep" : "rg/find through the built-in shell"} to locate matching implementation and tests. Try a few relevant English identifiers or synonyms; avoid repeating searches that return no matches. Read matching source and tests with Forge read_file/read_lines before editing. Use write_diff for new files and edit_diff for existing files with the exact checksum. Run checks with one run_check call, specifying the narrowest test or lint command that covers changed files. Do not run the full project suite unless requested or required. run_check returns the final result directly. Inspect git_status and git_diff before commit_changes. Then push only the returned commit SHA with push_commit.`
        : "Read workflows/agents/architecture/README.md with Forge read_file before architecture planning; follow its role boundaries and plan format. Use Forge search_tree for directory structure, list_files for file lists, search_text for content search. read_file({path}) returns Markdown content and the whole-file sha256 (up to 250 lines). For more Markdown use offset/limit; symbol is ignored for Markdown. For source code, read_file({path}) returns metadata and symbol map; pass symbol or offset/limit (at most 80 lines), or use read_lines, to read source. Use the exact sha256 from read_file as before_checksum for edit_diff or write_diff; never guess it. For architecture writing, use write_diff or edit_diff only within ARCHITECTURE.md, docs/, Skills/, or workflows/. Delete only files in workflows/ with delete_file after reading their checksum. Other files are read-only. Report tool results once, accurately.";
      const claudeOptions = claudeTools ? {
        ...createClaudeForgeOptions(claudeTools),
      } : {};
      if (usesClaudeSearch) {
        claudeOptions.tools = ["Glob", "Grep"];
        claudeOptions.canUseTool = createClaudeSearchPermission(projectRoot, (tool, status, detail = {}) => projectLogger?.({ event_name: "owner.builtin_search", level: status === "failed" ? "error" : "info", status, message: `Claude built-in ${tool} ${status}.`, task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, tool, ...detail } }));
        claudeOptions.onBuiltinToolEvent = (event) => projectLogger?.({ event_name: "owner.builtin_search", level: event.status === "failed" ? "error" : "info", status: event.status, message: `Claude built-in ${event.tool} ${event.status}.`, task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, tool: event.tool, ...(event.path ? { path: event.path } : {}), ...(Number.isInteger(event.result_bytes) ? { result_bytes: event.result_bytes } : {}) } });
      }
      const builtinSearchShell = usesOpenAiSearch ? createOwnerBuiltinSearchShell({ projectRoot, logger: ({ name, status, ...detail }) => projectLogger?.({ event_name: "owner.builtin_search", level: status === "failed" ? "error" : "info", status, message: `OpenAI built-in ${name} ${status}.`, task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, tool: name, ...detail } }) }) : undefined;
      const codexOptions = sdk.conversationMode === "thread" ? {
        sandboxMode: "read-only",
        approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled",
        ...(systemEngineer ? { config: { default_permissions: "audit" }, configOverrides: [codexFilesystemPolicy(projectRoot)] } : {})
      } : {};
      projectLogger?.({ event_name: "owner.sdk_request_started", level: "info", status: "started", message: "Owner SDK request started.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile.role, provider: profile.provider, conversation_mode: sdk.conversationMode, forge_tools: definitions.map((item) => item.name), builtins: builtinTools } });
      const execution = sdk.execute({ agentId, agent: profile, correlationId, cwd: projectRoot, prompt: `${toolInstruction}\n${sdk.conversationMode === "history" || !resumeThreadId ? history.map((turn) => `${turn.role}: ${turn.text}`).join("\n").slice(-8000) : ""}\nUser: ${payload.text}\n\n${fileToolInstruction}`, options: { forgeTools, builtinSearchShell, ...claudeOptions, ...codexOptions }, ...(sdk.conversationMode === "thread" ? { resumeThreadId: resumeThreadId ?? undefined, onSessionReady: (id) => { if (typeof id === "string" && id) threadId = id; }, onEvent: async (event) => { if (systemEngineer && event.type === "item.started" && isUnapprovedCodexTool(event.item, definitions, usesCodexSearch)) { const tool = `codex_builtin:${event.item?.type ?? "unknown"}`; projectLogger?.({ event_name: "owner.tool_call", level: "error", status: "failed", message: "System Engineer SDK built-in tool was blocked; use an approved project search tool.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", error_code: "TOOL_FORBIDDEN", payload: { tool, agent_id: agentId, agent_name: profile.agent_name, provider: profile.provider } }); throw Object.assign(new ConfigurationError(`Owner SDK conversation attempted an unapproved built-in tool: ${event.item?.type ?? "unknown"}.`), { code: "TOOL_FORBIDDEN" }); } if (systemEngineer && usesCodexSearch && event.item?.type === "command_execution" && (event.type === "item.started" || event.type === "item.completed")) projectLogger?.({ event_name: "owner.builtin_search", level: event.type === "item.completed" && event.item.status === "failed" ? "error" : "info", status: event.type === "item.started" ? "started" : event.item.status === "failed" ? "failed" : "success", message: `Codex built-in project search ${event.type === "item.started" ? "started" : event.item.status === "failed" ? "failed" : "completed"}.`, task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, tool: "command_execution" } }); if ((event.type !== "item.updated" && event.type !== "item.completed") || event.item?.type !== "agent_message") return; const current = event.item.text ?? ""; const previous = seenText.get(event.item.id) ?? ""; seenText.set(event.item.id, current); if (current.startsWith(previous) && current.length > previous.length) push({ text: current.slice(previous.length) }); else if (current !== previous && event.type === "item.completed") push({ text: current }); } } : {}) }).then((result) => { finalResult = result; }, (error) => { failure = error; projectLogger?.({ event_name: "owner.sdk_failed", level: "error", status: "failed", message: "Owner SDK conversation failed.", task_id: correlationId, correlation_id: correlationId, source: "owner-sdk-stream", error_code: error.code ?? "OWNER_SDK_FAILED", payload: { agent_id: agentId, provider: profile.provider } }); }).finally(() => { finished = true; wake?.(); wake = undefined; });
      while (!finished || queue.length) { if (!queue.length) await new Promise((resolve) => { wake = resolve; }); while (queue.length) yield queue.shift(); }
      await execution;
      if (failure) throw failure;
      projectLogger?.({ event_name: "owner.sdk_request_completed", level: "info", status: "success", message: "Owner SDK request completed.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, provider: profile.provider, response_chars: finalResult?.text?.length ?? 0, thread_id: threadId ?? finalResult?.thread_id ?? null } });
      if (finalResult?.text) await conversationStateStore?.update?.(conversationId, { sdk_provider: profile.provider, sdk_thread_id: sdk.conversationMode === "thread" ? (threadId ?? finalResult.thread_id ?? null) : null, sdk_history: [...history, { role: "User", text: payload.text }, { role: "Assistant", text: finalResult.text }].slice(-8) });
      if (sdk.conversationMode === "history" && finalResult?.text) yield { text: finalResult.text };
      if (sdk.conversationMode === "thread" && !seenText.size && finalResult?.text) yield { text: finalResult.text };
      if (finalResult?.usage) yield { usage: finalResult.usage };
    } finally { activeConversations.delete(conversationId); }
  }
}

// Constrains Codex shell file access to the project while preserving read access to system binaries.
function codexFilesystemPolicy(projectRoot) {
  const root = JSON.stringify(projectRoot);
  return `permissions.audit.filesystem={":root"="deny","/usr"="read","/bin"="read","/sbin"="read","/lib"="read","/lib64"="read","/etc/ld.so.cache"="read",${root}="read"}`;
}

// Rejects every Codex native action; System Engineer project operations must use the registered Forge MCP surface.
function isUnapprovedCodexTool(item, definitions, allowSearch = false) {
  if (!item || typeof item.type !== "string") return false;
  if (item.type === "command_execution") return !allowSearch || !isReadOnlySearchCommand(item.command);
  if (["file_change", "web_search", "local_shell_call", "image_view"].includes(item.type)) return true;
  if (item.type !== "mcp_tool_call") return false;
  return item.server !== "forge" || !definitions.some(({ name }) => name === item.tool);
}

// Allows only standalone read-only rg/find commands through Codex native shell.
function isReadOnlySearchCommand(command) {
  return typeof command === "string" && command.length <= 4000 && !/[\n\r;|&><`$]/.test(command) && /^\s*(?:rg|find)(?:\s|$)/.test(command) && !/(?:^|\s)--(?:pre|pre-glob|file|follow|files0-from)(?:=|\s|$)|(?:^|\s)-f(?!F)\S*|(?:^|\s)(?:-L(?:\s|$)|-exec(?:dir)?(?:\s|$)|-delete(?:\s|$)|-ok(?:dir)?(?:\s|$)|-fprint(?:\s|$)|-fprintf(?:\s|$)|-fls(?:\s|$))/.test(command) && !/(?:^|\s)(?:\/|\.{1,2}\/)/.test(command.replace(/^\s*(?:rg|find)\s+/, ""));
}

// Restricts Claude native discovery paths to project-relative directories and logs permission decisions.
function createClaudeSearchPermission(projectRoot, log) {
  const root = resolve(projectRoot);
  return async (tool, input = {}) => {
    const path = input.path ?? ".";
    const segments = typeof path === "string" ? path.split(/[\\/]/) : [];
    const target = typeof path === "string" ? resolve(root, path) : "";
    const glob = typeof input.glob === "string" ? input.glob : "";
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const hasTraversal = [glob, ...(tool === "Glob" ? [pattern] : [])].some((value) => value.split(/[\\/]/).includes("..") || isAbsolute(value));
    const withinProject = typeof path === "string" && !path.includes("\0") && !path.includes("\\") && !isAbsolute(path) && !segments.includes("..") && !hasTraversal && (target === root || target.startsWith(`${root}${sep}`));
    if (!["Glob", "Grep"].includes(tool) || !withinProject) {
      log(tool, "failed", { error_code: "TOOL_FORBIDDEN" });
      return { behavior: "deny", message: "Search is limited to project-relative paths." };
    }
    return { behavior: "allow", updatedInput: input };
  };
}

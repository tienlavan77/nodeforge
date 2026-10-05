// Streams owner conversations through the SDK selected by the agent profile.
import { ConfigurationError } from "../shared/errors.js";
import { createOwnerConversationTools } from "../tools/owner-conversation-tools.js";
import { ownerWritePaths, ownerWritePrefixes } from "../tools/owner-role-tool-policy.js";
import { createOwnerClaudeMcpTools } from "../tools/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../tools/claude-forge-options.js";

// Builds a role-scoped SDK stream with Forge-owned discovery and persisted conversation state.
export function createOwnerSdkStream({ agentConfiguration, sdkGateways, fallbackStream, conversationStateStore, conversationMessages, fileService, codeCache, codeSearch, gitService, projectRoot, projectLogger }) {
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
      const context = { task_id: correlationId, execution_id: correlationId, correlation_id: correlationId, agent_identity: { agent_id: agentId, agent_name: profile.agent_name, role: profile.role, provider: profile.provider }, allowed_write_paths: ownerWritePaths(payload.task?.candidate_files ?? []), allowed_write_prefixes: ownerWritePrefixes(profile.role), project_root: projectRoot, project_wide_access: profile.role === "system_engineer" };
      const { definitions, registry } = createOwnerConversationTools({ role: profile.role, projectRoot, fileService, codeCache, codeSearch, gitService, projectLogger, context });
      context.capabilities = definitions.map((item) => item.name);
      if (!definitions.length) throw new ConfigurationError(`No Forge conversation tools are available for role ${profile.role}.`);
      const forgeTools = { registry, context, definitions };
      const claudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(forgeTools) : null;
      const queue = []; let wake; let finished = false; let failure; let finalResult; let threadId;
      const push = (value) => { queue.push(value); wake?.(); wake = undefined; };
      const seenText = new Map();
      const systemEngineer = profile.role === "system_engineer";
      const builtinTools = systemEngineer ? (sdk.conversationMode === "thread" ? ["command_execution", "file_change"] : ["Bash", "Edit", "Write"]) : [];
      const toolInstruction = sdk.conversationMode === "thread" ? systemEngineer
        ? "You are the project's System Engineer. You may inspect and edit project files and run project commands directly. Keep every file operation and command's project data access inside the current project root. Use Forge search_tree, rg_files, rg_search, sed_lines, read_file, git_status, and git_diff when useful. Use command_execution for tests/checks and scoped Git commits. Commit with `git commit -m <message> -- <exact changed paths>`; never run `git add -A`, `git commit -a`, or a commit without explicit paths. Do not use web search."
        : "Use only the Forge tools listed in this turn. Never use built-in command_execution, file_change, or web_search tools. Answer directly when no project file is needed."
        : systemEngineer ? "You are the project's System Engineer. You may inspect and edit project files and run project commands directly. Keep file and command access inside the current project root. Use the supplied Forge tools when useful. Do not use network access or web search."
          : "";
      const fileToolInstruction = systemEngineer
        ? "This is direct project engineering, not a ticket. Read and modify any relevant project files using the provider's built-in file tools. Run suitable tests/checks with the provider's built-in command tool. Before committing, inspect git_status and git_diff; use `git commit -m <message> -- <exact changed paths>` so unrelated staged and working-tree changes are excluded."
        : "Read workflows/agents/architecture/README.md with Forge read_file before architecture planning; follow its role boundaries and plan format. Use Forge search_tree for directory structure, rg_files for file lists, rg_search for content search. read_file({path}) returns Markdown content and the whole-file sha256 (up to 250 lines). For more Markdown use offset/limit; symbol is ignored for Markdown. For source code, read_file({path}) returns metadata and symbol map; pass symbol or offset/limit (at most 80 lines), or use sed_lines, to read source. Use the exact sha256 from read_file as before_checksum for edit_diff or write_diff; never guess it. For architecture writing, use write_diff or edit_diff only within ARCHITECTURE.md, docs/, Skills/, or workflows/. Delete only files in workflows/ with delete_file after reading their checksum. Other files are read-only. Report tool results once, accurately.";
      const claudeOptions = claudeTools ? {
        ...createClaudeForgeOptions(claudeTools),
        ...(systemEngineer ? {
          tools: builtinTools,
          allowedTools: [...claudeTools.allowedTools, ...builtinTools],
          sandbox: { enabled: true, failIfUnavailable: true, filesystem: { denyRead: ["/"], allowRead: [projectRoot], allowWrite: [projectRoot] }, network: { allowedDomains: [] } },
          permissions: { blockReadsOutsideWorkingDirectories: true },
          canUseTool: async (toolName, input) => toolName === "Bash" && isUnsafeEngineerGitCommand(input?.command)
            ? { behavior: "deny", message: "System Engineer Git commits must name exact changed paths; broad staging and unscoped commits are blocked." }
            : { behavior: "allow", updatedInput: input }
        } : {})
      } : {};
      const codexOptions = sdk.conversationMode === "thread" ? {
        sandboxMode: systemEngineer ? "workspace-write" : "read-only",
        approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled",
        ...(systemEngineer ? { config: { default_permissions: "audit" }, configOverrides: [codexFilesystemPolicy(projectRoot)] } : {})
      } : {};
      projectLogger?.({ event_name: "owner.sdk_request_started", level: "info", status: "started", message: "Owner SDK request started.", task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId, source: "owner-sdk-stream", payload: { agent_id: agentId, role: profile.role, provider: profile.provider, conversation_mode: sdk.conversationMode, forge_tools: definitions.map((item) => item.name), builtins: builtinTools } });
      const execution = sdk.execute({ agentId, agent: profile, correlationId, cwd: projectRoot, prompt: `${toolInstruction}\n${sdk.conversationMode === "history" || !resumeThreadId ? history.map((turn) => `${turn.role}: ${turn.text}`).join("\n").slice(-8000) : ""}\nUser: ${payload.text}\n\n${fileToolInstruction}`, options: { forgeTools, ...claudeOptions, ...codexOptions }, ...(sdk.conversationMode === "thread" ? { resumeThreadId: resumeThreadId ?? undefined, onSessionReady: (id) => { if (typeof id === "string" && id) threadId = id; }, onEvent: async (event) => { if (event.type === "item.started" && ["command_execution", "file_change", "web_search"].includes(event.item?.type) && !(systemEngineer && ["command_execution", "file_change"].includes(event.item?.type))) throw Object.assign(new ConfigurationError(`Owner SDK conversation attempted an unapproved built-in tool: ${event.item.type}.`), { code: "TOOL_FORBIDDEN" }); if (systemEngineer && event.type === "item.started" && event.item?.type === "command_execution" && isUnsafeEngineerGitCommand(event.item.command)) throw Object.assign(new ConfigurationError("System Engineer shell command must use a path-scoped Git commit."), { code: "TOOL_FORBIDDEN" }); if ((event.type !== "item.updated" && event.type !== "item.completed") || event.item?.type !== "agent_message") return; const current = event.item.text ?? ""; const previous = seenText.get(event.item.id) ?? ""; seenText.set(event.item.id, current); if (current.startsWith(previous) && current.length > previous.length) push({ text: current.slice(previous.length) }); else if (current !== previous && event.type === "item.completed") push({ text: current }); } } : {}) }).then((result) => { finalResult = result; }, (error) => { failure = error; projectLogger?.({ event_name: "owner.sdk_failed", level: "error", status: "failed", message: "Owner SDK conversation failed.", task_id: correlationId, correlation_id: correlationId, source: "owner-sdk-stream", error_code: error.code ?? "OWNER_SDK_FAILED", payload: { agent_id: agentId, provider: profile.provider } }); }).finally(() => { finished = true; wake?.(); wake = undefined; });
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
  return `permissions.audit.filesystem={":root"="deny","/usr"="read","/bin"="read","/sbin"="read","/lib"="read","/lib64"="read","/etc/ld.so.cache"="read",${root}="write"}`;
}

// Prevents direct owner chat from staging or committing unrelated worktree changes.
function isUnsafeEngineerGitCommand(command) {
  if (typeof command !== "string") return false;
  if (/\bgit\s+add\s+(?:--all|-A)(?:\s|$)/i.test(command) || /\bgit\s+commit\b[^;&|]*(?:\s-a\b|\s--all\b)/i.test(command)) return true;
  return /\bgit\s+commit\b/i.test(command) && !/\bgit\s+commit\b[^;&|]*\s--\s+\S+/i.test(command);
}

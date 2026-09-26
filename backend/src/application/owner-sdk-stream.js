// Streams owner conversations through the SDK selected by the agent profile.
import { ConfigurationError } from "../shared/errors.js";
import { createOwnerConversationTools } from "../tools/owner-conversation-tools.js";
import { ownerWritePaths, ownerWritePrefixes } from "../tools/owner-role-tool-policy.js";
import { createOwnerClaudeMcpTools } from "../tools/owner-claude-mcp-tools.js";

// Builds a role-scoped SDK stream with Forge-owned discovery and persisted conversation state.
export function createOwnerSdkStream({ agentConfiguration, sdkGateways, fallbackStream, conversationStateStore, conversationMessages, fileService, projectRoot, projectLogger }) {
  if (typeof agentConfiguration?.getById !== "function" || typeof fallbackStream !== "function") throw new ConfigurationError("Owner SDK stream requires profiles and a fallback stream.");
  const activeConversations = new Set();
  return stream;

  // Selects an SDK by profile provider and returns its live text to the owner conversation.
  async function* stream({ agentId, payload, correlationId, conversationId, eventSink }) {
    const profile = agentConfiguration.getById(agentId);
    const sdk = sdkGateways?.[profile?.provider];
    if (profile?.role !== "architecture_manager") { yield* fallbackStream({ agentId, payload, correlationId, eventSink }); return; }
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
      const context = { task_id: correlationId, execution_id: correlationId, correlation_id: correlationId, agent_identity: { agent_id: agentId, role: profile.role, provider: profile.provider }, allowed_write_paths: ownerWritePaths(payload.task?.candidate_files ?? []), allowed_write_prefixes: ownerWritePrefixes(profile.role), project_root: projectRoot };
      const { definitions, registry } = createOwnerConversationTools({ role: profile.role, projectRoot, fileService, projectLogger, context });
      context.capabilities = definitions.map((item) => item.name);
      if (!definitions.length) throw new ConfigurationError(`No Forge conversation tools are available for role ${profile.role}.`);
      const forgeTools = { registry, context, definitions };
      const claudeTools = ["claude", "anthropic"].includes(profile.provider) ? createOwnerClaudeMcpTools(forgeTools) : null;
      const queue = []; let wake; let finished = false; let failure; let finalResult; let threadId;
      const push = (value) => { queue.push(value); wake?.(); wake = undefined; };
      const seenText = new Map();
      const toolInstruction = sdk.conversationMode === "thread" ? "Use only the Forge tools listed in this turn. Never use built-in command_execution, file_change, or web_search tools. Answer directly when no project file is needed." : "";
      const fileToolInstruction = "Use Forge search_tree for directory structure, rg_files for file lists, rg_search for content search, read_file or sed_lines for file contents. For architecture writing, use write_diff or edit_diff only within ARCHITECTURE.md, docs/, Skills/, or workflows/. Delete only files in workflows/ with delete_file after reading their checksum. Other files are read-only. Report tool results once, accurately.";
      const execution = sdk.execute({ agentId, agent: profile, correlationId, cwd: projectRoot, prompt: `${toolInstruction}\n${sdk.conversationMode === "history" || !resumeThreadId ? history.map((turn) => `${turn.role}: ${turn.text}`).join("\n").slice(-8000) : ""}\nUser: ${payload.text}\n\n${fileToolInstruction}`, options: { forgeTools, ...(claudeTools ? { tools: [], ...claudeTools } : {}), ...(sdk.conversationMode === "thread" ? { sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled" } : {}) }, ...(sdk.conversationMode === "thread" ? { resumeThreadId: resumeThreadId ?? undefined, onSessionReady: (id) => { if (typeof id === "string" && id) threadId = id; }, onEvent: async (event) => { if (event.type === "item.started" && ["command_execution", "file_change", "web_search"].includes(event.item?.type)) throw Object.assign(new ConfigurationError(`Owner SDK conversation attempted an unapproved built-in tool: ${event.item.type}.`), { code: "TOOL_FORBIDDEN" }); if ((event.type !== "item.updated" && event.type !== "item.completed") || event.item?.type !== "agent_message") return; const current = event.item.text ?? ""; const previous = seenText.get(event.item.id) ?? ""; seenText.set(event.item.id, current); if (current.startsWith(previous) && current.length > previous.length) push({ text: current.slice(previous.length) }); else if (current !== previous && event.type === "item.completed") push({ text: current }); } } : {}) }).then((result) => { finalResult = result; }, (error) => { failure = error; projectLogger?.({ event_name: "owner.sdk_failed", level: "error", status: "failed", message: "Owner SDK conversation failed.", task_id: correlationId, correlation_id: correlationId, source: "owner-sdk-stream", error_code: error.code ?? "OWNER_SDK_FAILED", payload: { agent_id: agentId, provider: profile.provider } }); }).finally(() => { finished = true; wake?.(); wake = undefined; });
      while (!finished || queue.length) { if (!queue.length) await new Promise((resolve) => { wake = resolve; }); while (queue.length) yield queue.shift(); }
      await execution;
      if (failure) throw failure;
      if (finalResult?.text) await conversationStateStore?.update?.(conversationId, { sdk_provider: profile.provider, sdk_thread_id: sdk.conversationMode === "thread" ? (threadId ?? finalResult.thread_id ?? null) : null, sdk_history: [...history, { role: "User", text: payload.text }, { role: "Assistant", text: finalResult.text }].slice(-8) });
      if (sdk.conversationMode === "history" && finalResult?.text) yield { text: finalResult.text };
      if (sdk.conversationMode === "thread" && !seenText.size && finalResult?.text) yield { text: finalResult.text };
      if (finalResult?.usage) yield { usage: finalResult.usage };
    } finally { activeConversations.delete(conversationId); }
  }
}

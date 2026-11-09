// Business purpose: coordinates the fixed two-model Read-Only Explorer failover policy (claude-haiku-4-5 <-> Claude-luna -> fallback_to_parent) across Owner Conversation and Ticket Runtime executions.
// Technical description: selects primary and fallback subagent models from the parent provider, executes the secondary model when the primary fails, and returns a safe fallback_to_parent payload if both fail.
import { ConfigurationError } from "../../shared/errors.js";
import { createOwnerClaudeMcpTools } from "../roles/owner-claude-mcp-tools.js";
import { createClaudeForgeOptions } from "../roles/claude-forge-options.js";
import { createForgeSdkMcpServer } from "../roles/claude-sdk-forge-tools.js";
import { coderToolDefinitions } from "../engineering-tool-catalog.js";
import { bindEngineeringTools } from "../engineering-tool-binding.js";

export const CLAUDE_SUBAGENT_MODEL = "claude-haiku-4-5";
export const CODEX_SUBAGENT_MODEL = "Claude-luna";

// Business purpose: determines the ordered subagent model failover chain from the parent agent provider.
// Technical description: returns claude-haiku-4-5 then Claude-luna for Claude/Anthropic parents, and Claude-luna then claude-haiku-4-5 for Codex/OpenAI parents.
export function resolveSubagentFailoverCandidates(parentProvider) {
  const normalized = String(parentProvider ?? "anthropic").toLowerCase();
  if (["codex", "openai"].includes(normalized)) {
    return [
      { provider: "codex", model: CODEX_SUBAGENT_MODEL, effort: "low" },
      { provider: "anthropic", model: CLAUDE_SUBAGENT_MODEL, effort: "low" }
    ];
  }
  return [
    { provider: "anthropic", model: CLAUDE_SUBAGENT_MODEL, effort: "low" },
    { provider: "codex", model: CODEX_SUBAGENT_MODEL, effort: "low" }
  ];
}

// Business purpose: resolves an enabled agent profile for the fallback provider when cross-provider subagent failover is triggered.
// Technical description: inspects agentConfiguration profiles or synthesizes a fallback profile so the secondary gateway can execute when configured.
export function resolveFallbackAgentProfile({ parentProfile, targetProvider, agentConfiguration } = {}) {
  const providerAliases = targetProvider === "codex" ? ["codex", "openai"] : ["anthropic", "claude"];
  if (parentProfile && providerAliases.includes(String(parentProfile.provider ?? "").toLowerCase())) return parentProfile;
  const listFn = agentConfiguration?.list ?? agentConfiguration?.getAll ?? agentConfiguration?.listProfiles;
  if (typeof listFn === "function") {
    const profiles = listFn.call(agentConfiguration);
    if (Array.isArray(profiles)) {
      const exactRole = profiles.find((item) => item?.enabled && (item.status === "ready" || item.status === "working") && item.role === parentProfile?.role && providerAliases.includes(String(item.provider ?? "").toLowerCase()));
      if (exactRole) return exactRole;
      const anyReady = profiles.find((item) => item?.enabled && (item.status === "ready" || item.status === "working") && providerAliases.includes(String(item.provider ?? "").toLowerCase()));
      if (anyReady) return anyReady;
    }
  }
  if (typeof agentConfiguration?.getById === "function") {
    for (const candidateId of [`${parentProfile?.agent_id ?? "agent"}-${targetProvider}`, targetProvider, targetProvider === "codex" ? "codex-default" : "claude-default"]) {
      try {
        const found = agentConfiguration.getById(candidateId);
        if (found?.enabled && (found.status === "ready" || found.status === "working")) return found;
      } catch { /* ignore lookup miss */ }
    }
  }
  return parentProfile ? { ...parentProfile, provider: targetProvider } : { agent_id: targetProvider, role: "system_engineer", provider: targetProvider };
}

// Business purpose: executes a Read-Only Explorer subagent task across the 3-tier failover chain without breaking the parent turn.
// Technical description: runs the primary model candidate, fails over to the cross-provider secondary candidate on non-abort errors, and returns fallback_to_parent if both fail.
export async function executeSubagentWithFailover({
  parentProvider, parentProfile, agentConfiguration, runCandidate, childContext, projectLogger, conversationId, correlationId
} = {}) {
  if (typeof runCandidate !== "function") throw new ConfigurationError("executeSubagentWithFailover requires a runCandidate callback.");
  const candidates = resolveSubagentFailoverCandidates(parentProvider ?? parentProfile?.provider);
  const errors = [];
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    if (childContext?.abortSignal?.aborted) throw childContext.abortSignal.reason ?? Object.assign(new Error("Parent execution was aborted."), { code: "SUBAGENT_ABORTED" });
    try {
      const profile = resolveFallbackAgentProfile({ parentProfile, targetProvider: candidate.provider, agentConfiguration });
      const result = await runCandidate({ provider: candidate.provider, model: candidate.model, effort: candidate.effort, profile, attempt: index + 1 });
      return {
        ...result,
        status: result?.status ?? "completed",
        fallback_to_parent: Boolean(result?.fallback_to_parent),
        subagent_model: candidate.model,
        subagent_provider: candidate.provider
      };
    } catch (error) {
      if (childContext?.abortSignal?.aborted || error?.code === "SUBAGENT_ABORTED") throw error;
      errors.push({ provider: candidate.provider, model: candidate.model, message: String(error?.message ?? "Subagent model failed.") });
      const nextCandidate = candidates[index + 1];
      if (nextCandidate) {
        projectLogger?.({
          event_name: "subagent.model_failover", level: "warn", status: "failover",
          message: `Subagent primary model ${candidate.model} failed; failing over to ${nextCandidate.model}.`,
          task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId ?? null, source: "subagent-failover-executor",
          payload: { failed_provider: candidate.provider, failed_model: candidate.model, next_provider: nextCandidate.provider, next_model: nextCandidate.model, error_message: String(error?.message ?? "").slice(0, 200) }
        });
      }
    }
  }
  projectLogger?.({
    event_name: "subagent.fallback_to_parent", level: "warn", status: "fallback_to_parent",
    message: "Both subagent models (claude-haiku-4-5 and Claude-luna) failed; parent agent must inspect the remaining paths directly.",
    task_id: correlationId, correlation_id: correlationId, conversation_id: conversationId ?? null, source: "subagent-failover-executor",
    payload: { attempts: errors }
  });
  return {
    status: "fallback_to_parent", fallback_to_parent: true,
    summary: "Both subagent models (claude-haiku-4-5 and Claude-luna) failed; parent agent must inspect the remaining paths directly.",
    observed_files: childContext?.observed_files ?? [], subagent_usage: null, attempts: errors
  };
}

// Business purpose: builds the Owner Conversation subagent childExecutor with automatic 3-tier model failover.
// Technical description: creates read-only explorer tools and dispatches across claude/anthropic and codex/openai SDK gateways.
export function createOwnerSubagentChildExecutor({
  context, profile, agentId, correlationId, conversationId, projectRoot, sdkGateways, agentConfiguration, createTools, projectLogger
}) {
  return async (task, child) => {
    const childContext = { ...context, ...child, execution_id: child.execution_id ?? `${correlationId}:sub:${task.id}`, correlation_id: child.correlation_id ?? `${correlationId}:sub:${task.id}`, capabilities: child.capabilities ?? child.tools, exploration_enabled: false, subagent_depth: child.subagent_depth ?? 1 };
    const childTools = createTools(childContext);
    const childForgeTools = { registry: childTools.registry, definitions: childTools.definitions, context: childContext };
    const prompt = `Read-Only Explorer objective: ${task.objective}${Array.isArray(task.paths) && task.paths.length ? `\nPrioritize paths: ${task.paths.join(", ")}` : ""}`;
    return executeSubagentWithFailover({
      parentProvider: profile.provider, parentProfile: profile, agentConfiguration, childContext, projectLogger, conversationId, correlationId: childContext.correlation_id,
      runCandidate: async ({ provider, model, profile: targetProfile }) => {
        const isClaude = ["claude", "anthropic"].includes(provider);
        const childSdk = isClaude ? (sdkGateways?.anthropic ?? sdkGateways?.claude ?? (["claude", "anthropic"].includes(profile.provider) ? sdkGateways?.[profile.provider] : null)) : (sdkGateways?.codex ?? sdkGateways?.openai ?? (["codex", "openai"].includes(profile.provider) ? sdkGateways?.[profile.provider] : null));
        if (typeof childSdk?.execute !== "function") throw Object.assign(new ConfigurationError(`No SDK child executor is configured for provider ${provider}.`), { code: "SUBAGENT_EXECUTOR_UNAVAILABLE" });
        const childClaudeTools = isClaude ? createOwnerClaudeMcpTools(childForgeTools) : null;
        const childProviderOptions = childClaudeTools ? createClaudeForgeOptions(childClaudeTools) : { sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled" };
        const result = await childSdk.execute({
          agentId: targetProfile?.agent_id ?? agentId, agent: targetProfile ?? profile, subagentId: child.subagentId, conversationId,
          correlationId: child.correlation_id ?? child.execution_id, prompt, cwd: projectRoot, abortSignal: child.abortSignal,
          options: { ...childProviderOptions, subagentModel: model, effort: "low", forgeTools: childForgeTools }
        });
        return { summary: result?.text ?? result?.response ?? "", observed_files: childContext.observed_files ?? [], subagent_usage: result?.usage ?? null };
      }
    });
  };
}

// Business purpose: builds the Ticket Runtime subagent childExecutor with automatic 3-tier model failover for Claude and Codex Coder agents.
// Technical description: binds read-only explorer tools in the ticket scope and fails over between claudeSdkGateway (claude-haiku-4-5) and codexSdkGateway (Claude-luna).
export function createTicketSubagentChildExecutor({
  selected, request, executionId, toolContext, toolRegistry, claudeSdkGateway, codexSdkGateway, extractFinalAgentReport, projectRoot, projectLogger
}) {
  const explorerToolNames = ["search_tree", "list_files", "search_text", "read_file", "Read", "git_status", "git_diff", "git_log", "git_show", "git_blame"];
  return async (task, child) => {
    const childContext = { ...toolContext, ...child, execution_id: child.execution_id ?? `${executionId}:sub:${task.id}`, correlation_id: child.correlation_id ?? `${request.correlation_id}:sub:${task.id}`, capabilities: child.capabilities ?? child.tools ?? explorerToolNames, exploration_enabled: false, subagent_depth: child.subagent_depth ?? 1, observed_files: child.observed_files ?? [] };
    const childBinding = bindEngineeringTools({ registry: toolRegistry, context: childContext });
    const prompt = `Read-Only Explorer objective: ${task.objective}${Array.isArray(task.paths) && task.paths.length ? `\nPrioritize paths: ${task.paths.join(", ")}` : ""}`;
    return executeSubagentWithFailover({
      parentProvider: selected.provider ?? "anthropic", parentProfile: selected, childContext, projectLogger, conversationId: request.task_id, correlationId: childContext.correlation_id,
      runCandidate: async ({ provider, model, profile: targetProfile }) => {
        if (["claude", "anthropic"].includes(provider)) {
          if (typeof claudeSdkGateway?.execute !== "function") throw Object.assign(new ConfigurationError("Claude SDK gateway is unavailable for subagent failover."), { code: "SUBAGENT_EXECUTOR_UNAVAILABLE" });
          const childRegistry = Object.fromEntries(explorerToolNames.filter((name) => childBinding.registry[name]).map((name) => [name, childBinding.registry[name]]));
          const childMcpServers = { forge: createForgeSdkMcpServer({ registry: childRegistry, context: childBinding.context, includeEngineeringTools: true }) };
          const childAllowedTools = explorerToolNames.map((name) => `mcp__forge__${name}`);
          const childRes = await claudeSdkGateway.execute({
            agentId: targetProfile?.agent_id ?? selected.agent_id, agent: targetProfile ?? selected, subagentId: child.subagentId,
            correlationId: child.correlation_id ?? childContext.correlation_id, cwd: projectRoot, abortSignal: child.abortSignal ?? request.abortSignal,
            options: { ...createClaudeForgeOptions({ mcpServers: childMcpServers, allowedTools: childAllowedTools }, { effort: "low" }), subagentModel: model }, prompt
          });
          return { summary: extractFinalAgentReport?.(childRes?.messages) || childRes?.text || "", observed_files: childContext.observed_files ?? [], subagent_usage: childRes?.usage ?? null };
        }
        if (typeof codexSdkGateway?.execute !== "function") throw Object.assign(new ConfigurationError("Codex SDK gateway is unavailable for subagent failover."), { code: "SUBAGENT_EXECUTOR_UNAVAILABLE" });
        const codexExplorerNames = ["search_tree", "list_files", "search_text", "read_file", "Read"];
        const childDefinitions = coderToolDefinitions().filter(({ name }) => codexExplorerNames.includes(name));
        const childRegistry = Object.fromEntries(childDefinitions.map(({ name }) => [name, childBinding.registry[name]]));
        const childRes = await codexSdkGateway.execute({
          agentId: targetProfile?.agent_id ?? selected.agent_id, agent: targetProfile ?? selected, subagentId: child.subagentId,
          correlationId: child.correlation_id ?? childContext.correlation_id, cwd: projectRoot, abortSignal: child.abortSignal ?? request.abortSignal,
          options: { subagentModel: model, effort: "low", sandboxMode: "read-only", approvalPolicy: "on-request", networkAccessEnabled: false, webSearchMode: "disabled", forgeTools: { registry: childRegistry, context: childBinding.context, definitions: childDefinitions } }, prompt
        });
        return { summary: childRes?.text ?? childRes?.response ?? "", observed_files: childContext.observed_files ?? [], subagent_usage: childRes?.usage ?? null };
      }
    });
  };
}

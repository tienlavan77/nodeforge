// Executes OpenAI Agents SDK runs with per-agent provider and timeout control.
import { Agent, Runner, shellTool, tool, webSearchTool } from "@openai/agents";
import { ConfigurationError } from "../../shared/errors.js";
import { sdkFailureEvidence } from "./sdk-failure-evidence.js";
import { createSdkTerminalLog } from "./sdk-terminal-log.js";

// Creates a gateway that runs an Agent via the OpenAI Agents SDK.
export function createOpenAiSdkGateway({ providerFactory, runner = createTracingDisabledRunner(), AgentClass = Agent, timeoutMs = 3600000, terminalOutput = process.stdout } = {}) {
  if (typeof providerFactory?.createForAgent !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires a provider factory.");
  if (typeof runner !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent runner.");
  if (typeof AgentClass !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent constructor.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("OpenAI SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute, provider: "openai", conversationMode: "history", builtinWebSearchAvailable: supportsBuiltinWebSearch });

  // Defines execute function behavior for openai-sdk-gateway.js.
  async function execute({ agent, agentId, prompt, correlationId, options = {}, abortSignal } = {}) {
    const profile = agent ?? { agent_id: agentId };
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("OpenAI SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId) throw new ConfigurationError("OpenAI SDK correlation_id is required.");
    const { provider, profile: normalized } = await providerFactory.createForAgent(profile);
    const useBuiltinWebSearch = options.builtinWebSearch && supportsBuiltinWebSearch({ ...normalized, provider: profile.provider });
    const controller = new AbortController();
    // Defines abort function behavior for openai-sdk-gateway.js.
    const abort = () => controller.abort(abortSignal.reason);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    // The normalized profile grants System Engineer unlimited session time while retaining explicit Stop.
    const timer = normalized.role === "system_engineer" ? null : setTimeout(() => controller.abort(), timeoutMs);
    let terminalFailure;
    const terminal = createSdkTerminalLog({ profile: normalized, correlationId, context: options.forgeTools?.context, output: terminalOutput });
    try {
      const agentOptions = {
        name: normalized.agent_name,
        instructions: `You are the NodeForge ${normalized.role} agent. Respond briefly and clearly.`,
        model: normalized.model,
        tools: [
          ...(useBuiltinWebSearch ? [webSearchTool()] : []),
          ...(options.builtinSearchShell ? [shellTool({ shell: options.builtinSearchShell, needsApproval: false })] : []),
          ...(options.forgeTools?.definitions ?? []).map((definition) => tool({
          name: definition.name,
          description: definition.description,
          parameters: compatibleToolParameters(definition.input_schema),
          strict: false,
          execute: async (input) => JSON.stringify(await options.forgeTools.registry[definition.name].execute(input, options.forgeTools.context))
          }))
        ]
      };
      if (normalized.reasoning.effort !== "none") agentOptions.modelSettings = { reasoning: { effort: normalized.reasoning.effort } };
      const openaiAgent = new AgentClass(agentOptions);
      const input = Array.isArray(options.history) ? [...options.history, { role: "user", content: prompt }] : prompt;
      const result = await runner(openaiAgent, input, { modelProvider: provider, signal: controller.signal, maxTurns: null, tracingDisabled: true });
      const usage = extractOpenAiRunnerUsage(result);
      const lastRawUsage = Array.isArray(result?.rawResponses) ? result.rawResponses.map((item) => item?.usage).filter(Boolean).at(-1) : undefined;
      return {
        ...(usage ? { usage } : {}),
        ...(lastRawUsage ? { last_call_usage: lastRawUsage } : {}),
        agent_id: normalized.agent_id,
        agent_name: normalized.agent_name,
        role: normalized.role,
        correlation_id: correlationId,
        status: "completed",
        ...(options.retainHistory ? { turn_completed: true, history: result.history } : {}),
        text: extractText(result?.finalOutput)
      };
    } catch (error) {
      terminalFailure = error;
      if (abortSignal?.aborted) throw abortSignal.reason ?? error;
      if (error?.name === "AbortError" || controller.signal.aborted) throw sdkFailureEvidence(new ConfigurationError(`OpenAI SDK request timed out for ${normalized.agent_id}.`, { cause: error }), error, { aborted: true });
      if (error instanceof ConfigurationError) throw error;
      throw sdkFailureEvidence(new ConfigurationError(`OpenAI SDK request failed for ${normalized.agent_id}: ${error?.message ?? "unknown SDK error"}`, { cause: error }), error);
    } finally {
      terminal.close(abortSignal?.aborted ? { code: "TICKET_STOPPED", message: "SDK session stopped." } : controller.signal.aborted ? { code: "SDK_REQUEST_TIMEOUT", message: "SDK request timed out." } : terminalFailure);
      abortSignal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      await provider.close?.();
    }
  }

  // Allows native web search only for approved roles using the Responses API contract.
  function supportsBuiltinWebSearch(profile) {
    return ["architecture_manager", "system_engineer", "sprint_leader"].includes(profile?.role)
      && profile?.use_responses !== false
      && !["ollama", "xai", "alibaba", "zhipu", "deepseek"].includes(profile?.provider);
  }
}

// Removes unsupported path regex from model-facing tools while Forge still validates paths on execution.
function compatibleToolParameters(schema) {
  const parameters = structuredClone(schema);
  if (typeof parameters.properties?.path?.pattern === "string" && parameters.properties.path.pattern.includes("(?!")) {
    delete parameters.properties.path.pattern;
  }
  return parameters;
}

// Creates an OpenAI Runner configured with tracing disabled for Node execution.
function createTracingDisabledRunner() {
  return (agent, input, options) => {
    const { modelProvider, ...runOptions } = options;
    const sdkRunner = new Runner({ modelProvider, tracingDisabled: true });
    return sdkRunner.run(agent, input, runOptions);
  };
}

// Extracts the textual final output from an SDK result, stringifying non-strings.
function extractText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

// Business purpose: normalizes token usage reported by @openai/agents runs so
// Owner Chat and Ticket execution can track context consumption and trigger
// automatic session/history compaction rollover across OpenAI and compatible
// providers. Technical description: extracts input/output/cached token counts
// from result.usage, result.rawResponses, or result.state._context.usage.
function extractOpenAiRunnerUsage(result) {
  if (!result || typeof result !== "object") return undefined;
  const direct = result.usage ?? result.state?._context?.usage ?? result.state?.usage;
  const rawList = Array.isArray(result.rawResponses) ? result.rawResponses.map((item) => item?.usage).filter(Boolean) : [];
  const sources = rawList.length ? rawList : direct && typeof direct === "object" ? [direct] : [];
  if (!sources.length) return undefined;
  const totals = sources.reduce((acc, u) => {
    const input = Number(u.input_tokens ?? u.inputTokens ?? u.prompt_tokens ?? u.promptTokens ?? 0);
    const output = Number(u.output_tokens ?? u.outputTokens ?? u.completion_tokens ?? u.completionTokens ?? 0);
    const disjointCacheRead = Number(u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? 0);
    const cacheCreate = Number(u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? 0);
    const hasDisjoint = u.cache_read_input_tokens !== undefined || u.cacheReadInputTokens !== undefined;
    const inclusiveCached = hasDisjoint ? 0 : Number(
      u.cached_input_tokens ?? u.cachedInputTokens ?? u.cached_tokens
      ?? u.input_tokens_details?.cached_tokens ?? u.inputTokensDetails?.cachedTokens
      ?? u.prompt_tokens_details?.cached_tokens ?? 0
    );
    return {
      input_tokens: acc.input_tokens + (Number.isFinite(input) ? input : 0),
      output_tokens: acc.output_tokens + (Number.isFinite(output) ? output : 0),
      cached_input_tokens: acc.cached_input_tokens + (Number.isFinite(inclusiveCached) ? inclusiveCached : 0) + (Number.isFinite(disjointCacheRead) ? disjointCacheRead : 0),
      cache_read_input_tokens: acc.cache_read_input_tokens + (Number.isFinite(disjointCacheRead) ? disjointCacheRead : 0),
      cache_creation_input_tokens: acc.cache_creation_input_tokens + (Number.isFinite(cacheCreate) ? cacheCreate : 0),
      hasDisjoint: acc.hasDisjoint || hasDisjoint
    };
  }, { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, hasDisjoint: false });
  if (totals.input_tokens <= 0 && totals.output_tokens <= 0 && totals.cached_input_tokens <= 0 && totals.cache_creation_input_tokens <= 0) return undefined;
  const requests = rawList.length ? 0 : Number(direct?.requests ?? direct?.rounds ?? result.requests ?? result.rounds ?? 0);
  return {
    input_tokens: totals.input_tokens,
    output_tokens: totals.output_tokens,
    cached_input_tokens: totals.cached_input_tokens,
    ...(totals.hasDisjoint ? { cache_read_input_tokens: totals.cache_read_input_tokens } : {}),
    ...(totals.cache_creation_input_tokens > 0 ? { cache_creation_input_tokens: totals.cache_creation_input_tokens } : {}),
    ...(Number.isFinite(requests) && requests > 1 ? { requests } : {})
  };
}

// Executes OpenAI Agents SDK runs with per-agent provider and timeout control.
import { Agent, Runner, shellTool, tool, webSearchTool } from "@openai/agents";
import { ConfigurationError } from "../../shared/errors.js";

// Creates a gateway that runs an Agent via the OpenAI Agents SDK.
export function createOpenAiSdkGateway({ providerFactory, runner = createTracingDisabledRunner(), AgentClass = Agent, timeoutMs = 3600000 } = {}) {
  if (typeof providerFactory?.createForAgent !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires a provider factory.");
  if (typeof runner !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent runner.");
  if (typeof AgentClass !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent constructor.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("OpenAI SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute, provider: "openai", conversationMode: "history", builtinWebSearchAvailable: supportsBuiltinWebSearch });

  async function execute({ agent, agentId, prompt, correlationId, options = {}, abortSignal } = {}) {
    const profile = agent ?? { agent_id: agentId };
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("OpenAI SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId) throw new ConfigurationError("OpenAI SDK correlation_id is required.");
    const { provider, profile: normalized } = await providerFactory.createForAgent(profile);
    const useBuiltinWebSearch = options.builtinWebSearch && supportsBuiltinWebSearch({ ...normalized, provider: profile.provider });
    const controller = new AbortController();
    const abort = () => controller.abort(abortSignal.reason);
    abortSignal?.addEventListener("abort", abort, { once: true });
    if (abortSignal?.aborted) abort();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      const result = await runner(openaiAgent, prompt, { modelProvider: provider, signal: controller.signal, maxTurns: null, tracingDisabled: true });
      return {
        agent_id: normalized.agent_id,
        agent_name: normalized.agent_name,
        role: normalized.role,
        correlation_id: correlationId,
        status: "completed",
        text: extractText(result?.finalOutput)
      };
    } catch (error) {
      if (abortSignal?.aborted) throw abortSignal.reason ?? error;
      if (error?.name === "AbortError" || controller.signal.aborted) throw new ConfigurationError(`OpenAI SDK request timed out for ${normalized.agent_id}.`, { cause: error });
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`OpenAI SDK request failed for ${normalized.agent_id}: ${error?.message ?? "unknown SDK error"}`, { cause: error });
    } finally {
      abortSignal?.removeEventListener("abort", abort);
      clearTimeout(timer);
      await provider.close?.();
    }
  }

  // Allows native web search only for approved roles using the Responses API contract.
  function supportsBuiltinWebSearch(profile) {
    return ["architecture_manager", "system_engineer"].includes(profile?.role)
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

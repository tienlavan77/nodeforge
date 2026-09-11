import { Agent, Runner } from "@openai/agents";
import { ConfigurationError } from "../../shared/errors.js";

export function createOpenAiSdkGateway({ providerFactory, runner = createTracingDisabledRunner(), AgentClass = Agent, timeoutMs = 120000 } = {}) {
  if (typeof providerFactory?.createForAgent !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires a provider factory.");
  if (typeof runner !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent runner.");
  if (typeof AgentClass !== "function") throw new ConfigurationError("OpenAI SDK Gateway requires an Agent constructor.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("OpenAI SDK Gateway timeout must be a positive integer.");

  return Object.freeze({ execute });

  async function execute({ agent, agentId, prompt, correlationId } = {}) {
    const profile = agent ?? { agent_id: agentId };
    if (typeof prompt !== "string" || !prompt.trim()) throw new ConfigurationError("OpenAI SDK prompt is required.");
    if (typeof correlationId !== "string" || !correlationId) throw new ConfigurationError("OpenAI SDK correlation_id is required.");
    const { provider, profile: normalized } = await providerFactory.createForAgent(profile);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const agentOptions = {
        name: normalized.agent_name,
        instructions: `You are the NodeForge ${normalized.role} agent. Respond briefly and clearly.`,
        model: normalized.model,
        tools: []
      };
      if (normalized.reasoning.effort !== "none") agentOptions.modelSettings = { reasoning: { effort: normalized.reasoning.effort } };
      const openaiAgent = new AgentClass(agentOptions);
      const result = await runner(openaiAgent, prompt, { modelProvider: provider, signal: controller.signal, maxTurns: 1, tracingDisabled: true });
      return {
        agent_id: normalized.agent_id,
        agent_name: normalized.agent_name,
        role: normalized.role,
        correlation_id: correlationId,
        status: "completed",
        text: extractText(result?.finalOutput)
      };
    } catch (error) {
      if (error?.name === "AbortError" || controller.signal.aborted) throw new ConfigurationError(`OpenAI SDK request timed out for ${normalized.agent_id}.`, { cause: error });
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`OpenAI SDK request failed for ${normalized.agent_id}: ${error?.message ?? "unknown SDK error"}`, { cause: error });
    } finally {
      clearTimeout(timer);
      await provider.close?.();
    }
  }
}

function createTracingDisabledRunner() {
  const sdkRunner = new Runner({ tracingDisabled: true });
  return (agent, input, options) => sdkRunner.run(agent, input, options);
}

function extractText(value) {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value);
}

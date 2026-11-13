// Keeps Claude SDK and Anthropic API prompt caching enabled with comparable usage evidence.
const CACHE_DISABLE_FLAGS = ["DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING_HAIKU", "DISABLE_PROMPT_CACHING_SONNET", "DISABLE_PROMPT_CACHING_OPUS"];

// Enables SDK-managed cache reads and writes for every Claude model family.
export function claudeCacheEnvironment({ subagent = false } = {}) {
  const ttl = subagent ? "5m" : "1h";
  return { ...Object.fromEntries(CACHE_DISABLE_FLAGS.map((name) => [name, "0"])),
    CLAUDE_CODE_PROMPT_CACHE_TTL: ttl,
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "5m",
    FORCE_PROMPT_CACHING_5M: subagent ? "1" : "0"
  };
}

// Marks explicitly stable API blocks for cache creation and subsequent prefix reuse.
export function anthropicCacheControl(payload, cacheable) {
  if (!cacheable || payload.cache_enabled === false) return {};
  const ttl = payload.cache_config?.ttl ?? "1h";
  if (!["5m", "1h"].includes(ttl)) throw new Error("Anthropic prompt cache TTL must be 5m or 1h.");
  return { cache_control: { type: "ephemeral", ttl } };
}

// Business purpose: extracts the prompt context window size from the final assistant turn in a Claude SDK message stream so multi-step tool loops do not trigger premature session rollover.
// Technical description: locates the last assistant message containing a usage object and sums its single-call input_tokens, cache_creation_input_tokens, and cache_read_input_tokens.
function extractLastAssistantContextTokens(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const entry = messages[index];
    if (entry?.type !== "assistant") continue;
    const usage = entry.message?.usage ?? entry.usage;
    if (!usage || typeof usage !== "object") continue;
    const input = Number(usage.input_tokens ?? usage.inputTokens ?? 0);
    const cacheCreate = Number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens ?? 0);
    const cacheRead = Number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens ?? 0);
    const total = (Number.isFinite(input) ? input : 0) + (Number.isFinite(cacheCreate) ? cacheCreate : 0) + (Number.isFinite(cacheRead) ? cacheRead : 0);
    if (total > 0) return total;
  }
  return undefined;
}

// Reads the latest cumulative SDK model totals without double-counting intermediate results.
export function claudeCacheUsage(messages) {
  const result = messages.findLast((message) => message.type === "result");
  const contextTokens = extractLastAssistantContextTokens(messages);
  if (!result) return undefined;
  const models = Object.values(result.modelUsage ?? {});
  if (!models.length) {
    if (!result.usage) return undefined;
    return contextTokens !== undefined ? { ...result.usage, context_input_tokens: contextTokens } : result.usage;
  }
  const totals = models.reduce((total, model) => ({
    input_tokens: total.input_tokens + Number(model.inputTokens ?? 0),
    output_tokens: total.output_tokens + Number(model.outputTokens ?? 0),
    cache_creation_input_tokens: total.cache_creation_input_tokens + Number(model.cacheCreationInputTokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + Number(model.cacheReadInputTokens ?? 0)
  }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
  return contextTokens !== undefined ? { ...totals, context_input_tokens: contextTokens } : totals;
}

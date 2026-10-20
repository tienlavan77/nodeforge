// Keeps Claude SDK and Anthropic API prompt caching enabled with comparable usage evidence.
const CACHE_DISABLE_FLAGS = ["DISABLE_PROMPT_CACHING", "DISABLE_PROMPT_CACHING_HAIKU", "DISABLE_PROMPT_CACHING_SONNET", "DISABLE_PROMPT_CACHING_OPUS"];

// Enables SDK-managed cache reads and writes for every Claude model family.
export function claudeCacheEnvironment() {
  return { ...Object.fromEntries(CACHE_DISABLE_FLAGS.map((name) => [name, "0"])),
    CLAUDE_CODE_PROMPT_CACHE_TTL: "1h",
    CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL: "1h",
    FORCE_PROMPT_CACHING_5M: "0"
  };
}

// Marks explicitly stable API blocks for cache creation and subsequent prefix reuse.
export function anthropicCacheControl(payload, cacheable) {
  if (!cacheable || payload.cache_enabled === false) return {};
  const ttl = payload.cache_config?.ttl ?? "1h";
  if (!["5m", "1h"].includes(ttl)) throw new Error("Anthropic prompt cache TTL must be 5m or 1h.");
  return { cache_control: { type: "ephemeral", ttl } };
}

// Reads the latest cumulative SDK model totals without double-counting intermediate results.
export function claudeCacheUsage(messages) {
  const result = messages.findLast((message) => message.type === "result");
  if (!result) return undefined;
  const models = Object.values(result.modelUsage ?? {});
  if (!models.length) return result.usage;
  return models.reduce((total, model) => ({
    input_tokens: total.input_tokens + Number(model.inputTokens ?? 0),
    output_tokens: total.output_tokens + Number(model.outputTokens ?? 0),
    cache_creation_input_tokens: total.cache_creation_input_tokens + Number(model.cacheCreationInputTokens ?? 0),
    cache_read_input_tokens: total.cache_read_input_tokens + Number(model.cacheReadInputTokens ?? 0)
  }), { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
}

export function buildMessages(payload = {}, provider = payload.provider ?? payload.provider_name ?? payload.agent_provider ?? "openai") {
  if (Array.isArray(payload.messages) && payload.messages.length) return payload.messages;
  if (isAnthropicProvider(provider)) return buildAnthropicMessages(payload);
  if (!payload.stable_context && !payload.dynamic_context) return [{ role: "user", content: payload.text ?? JSON.stringify(payload) }];
  const messages = [];
  if (payload.stable_context) {
    const { _cache_control: cacheControl, ...stableForProvider } = payload.stable_context;
    messages.push({ role: "user", content: [{ type: "text", text: JSON.stringify(stableForProvider), ...(payload.cache_enabled && cacheControl === "ephemeral" ? { cache_control: { type: "ephemeral" } } : {}) }] });
  }
  messages.push({ role: "user", content: JSON.stringify(payload.dynamic_context ?? { instruction: payload.text ?? "" }) });
  return messages;
}

export function buildAnthropicSystem(payload = {}) {
  const blocks = [];
  for (const block of payload.instruction_blocks ?? []) {
    if (!block?.content) continue;
    const contentBlock = { type: "text", text: String(block.content) };
    if (block.cacheable) contentBlock.cache_control = { type: "ephemeral" };
    blocks.push(contentBlock);
  }
  return blocks.length ? blocks : undefined;
}

export function buildAnthropicMessages(payload = {}) {
  const messages = [];
  for (const block of payload.transcript_blocks ?? []) {
    messages.push({ role: block.role === "assistant" ? "assistant" : "user", content: [{ type: "text", text: transcriptBlockText(block) }] });
  }
  const userText = joinBlocks(payload.user_blocks);
  if (userText) messages.push({ role: "user", content: [{ type: "text", text: userText }] });
  if (!messages.length && typeof payload.text === "string" && payload.text) return [{ role: "user", content: [{ type: "text", text: payload.text }] }];
  return messages;
}

export function buildOpenAIMessages(payload = {}) {
  if (Array.isArray(payload.messages) && payload.messages.length) return payload.messages;
  return buildMessages(payload, "openai");
}

export function buildAnthropicToolChoice(payload = {}, tools = []) {
  const expected = payload.expected_output?.type ?? payload.expected_submission?.type;
  const transport = payload.expected_output?.transport ?? payload.expected_submission?.transport;
  if (transport !== "function_tool") return undefined;
  const aliases = { submit_code: "submit_code_response", code_response: "submit_code_response", request_info: "code_needed", usage_report: "usage_needed" };
  const expectedName = aliases[expected] ?? expected;
  if (!expectedName) return undefined;
  const matched = tools.find((tool) => tool?.name === expectedName);
  return matched ? { type: "tool", name: matched.name } : undefined;
}

export function mapUsage(usage = {}) {
  return { input_tokens: Number(usage.input_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? 0), cache_creation_input_tokens: Number(usage.cache_creation_input_tokens ?? 0), cache_read_input_tokens: Number(usage.cache_read_input_tokens ?? 0) };
}

function isAnthropicProvider(provider) {
  return ["anthropic", "claude", "devquote"].includes(provider);
}

function joinBlocks(blocks = []) {
  return (blocks ?? []).map((block) => blockText(block)).filter(Boolean).join("\n\n");
}

function blockText(block = {}) {
  if (typeof block.content === "string") return block.content;
  if (typeof block.text === "string") return block.text;
  return "";
}

function transcriptBlockText(block = {}) {
  if (typeof block.response_summary === "string") {
    return JSON.stringify({ round: block.round, instruction: block.instruction, response_summary: block.response_summary, full_request_ref: block.full_request_ref, full_response_ref: block.full_response_ref });
  }
  return blockText(block);
}

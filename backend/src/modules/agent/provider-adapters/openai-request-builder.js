import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const openAIResponseSchema = require("../../../../../schemas/agent/response-openai.schema.json");

export function buildResponsesInput(payload = {}) {
  if (!Array.isArray(payload.developer_blocks) && !Array.isArray(payload.user_blocks)) return payload.text ?? JSON.stringify(payload);
  const blocks = [];
  for (const block of payload.developer_blocks ?? []) blocks.push({ role: "developer", content: [{ type: "input_text", text: block.content, ...(block.cacheable ? { prompt_cache_breakpoint: true } : {}) }] });
  for (const block of payload.transcript_blocks ?? []) blocks.push({ role: "user", content: [{ type: "input_text", text: JSON.stringify({ round: block.round, instruction: block.instruction, response_summary: block.response_summary, full_request_ref: block.full_request_ref, full_response_ref: block.full_response_ref }) }] });
  for (const block of payload.user_blocks ?? []) blocks.push({ role: "user", content: [{ type: "input_text", text: block.content }] });
  return blocks;
}

// OpenAI Responses accepts developer guidance as the top-level instructions
// string. Keep block order and leave caching to request-level options.
export function buildInstructions(payload = {}) {
  const blocks = [
    ...(payload.instruction_blocks ?? []),
    ...(payload.developer_blocks ?? [])
  ];
  return blocks.map((block) => String(block.content ?? "")).join("\n\n");
}

export function buildInput(payload = {}, resolvedTranscript = []) {
  if (!Array.isArray(resolvedTranscript)) throw new TypeError("resolvedTranscript must be an array.");
  const input = [...resolvedTranscript]
    .sort((left, right) => left.round - right.round)
    .map((block) => ({ role: "user", content: [{ type: "input_text", text: transcriptText(block) }] }));
  for (const block of payload.user_blocks ?? []) input.push({ role: "user", content: [{ type: "input_text", text: String(block.content ?? "") }] });
  return input;
}

export function buildToolConfig(payload = {}) {
  const definitions = Array.isArray(openAIResponseSchema.tools) ? openAIResponseSchema.tools : [];
  // Provider projection may intentionally narrow or widen the canonical
  // envelope (for example, first round allows code_needed). Prefer it.
  const expected = payload.expected_output?.type ?? payload.expected_submission?.type;
  const expectedTypes = Array.isArray(expected) ? expected : expected ? [expected] : [];
  const aliases = { submit_code: "submit_code_response", code_response: "submit_code_response", request_info: "code_needed", usage_report: "usage_needed" };
  const names = expectedTypes.map((type) => aliases[type] ?? type);
  const selected = names.length ? definitions.filter((tool) => names.includes(tool.name)) : definitions;
  if (!selected.length) throw new Error(`No OpenAI response tool matches expected output: ${expectedTypes.join(", ") || "<none>"}.`);
  const requiredFormat = payload.expected_output?.representation ?? payload.expected_submission?.representation ?? payload.expected_output?.format ?? payload.expected_submission?.format;
  const tools = selected.map(({ type, name, description, strict, parameters }) => ({
    type, name, description, strict,
    parameters: name === "submit_code_response" && requiredFormat === "full_content"
      ? constrainSubmitFormat(parameters, "full_content")
      : parameters
  }));
  // Responses API uses the string "auto" for a choice among multiple tools;
  // the Chat Completions { type: "any" } form is rejected with HTTP 400.
  return { tools, ...(tools.length > 1 ? { tool_choice: "auto" } : { tool_choice: { type: "function", name: tools[0].name } }) };
}

/** Build the Responses API structured-output projection when explicitly requested. */
export function buildResponseFormat(payload = {}, toolConfig = buildToolConfig(payload)) {
  const transport = payload.expected_output?.transport ?? payload.expected_submission?.transport ?? "function_tool";
  if (transport !== "json_schema") return {};
  if (toolConfig.tools.length !== 1) throw new Error("JSON Schema transport requires exactly one response type.");
  const tool = toolConfig.tools[0];
  return { text: { format: { type: "json_schema", name: tool.name, schema: tool.parameters, strict: true } } };
}

function constrainSubmitFormat(parameters, format) {
  const copy = structuredClone(parameters);
  const formatSchema = copy?.properties?.files?.items?.properties?.format;
  if (formatSchema) formatSchema.enum = [format];
  return copy;
}

export function buildCacheOptions(payload = {}) {
  const config = payload.cache_config;
  if (!config) return undefined;
  return { prompt_cache_key: config.prompt_cache_key, prompt_cache_options: { mode: config.mode, ttl: config.ttl } };
}

export function mapOpenAIUsage(usage = {}) {
  return { cached_tokens: Number(usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cached_tokens ?? 0), input_tokens: Number(usage.input_tokens ?? usage.prompt_tokens ?? 0), output_tokens: Number(usage.output_tokens ?? usage.completion_tokens ?? 0) };
}

function transcriptText(block) {
  if (!block.in_window) return block.text ?? "";
  return JSON.stringify({ round: block.round, instruction: block.instruction ?? "", request: block.full_request, response: block.full_response });
}

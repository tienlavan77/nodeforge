import { randomUUID } from "node:crypto";

import { ConfigurationError } from "../../../shared/errors.js";
import { assertValidEnvelope } from "../../protocol/envelope-validator.js";

const TOOL_TYPES = Object.freeze({
  code_needed: "code_needed",
  request_info: "code_needed",
  planning: "planning",
  submit_code: "submit_code_response",
  submit_code_response: "submit_code_response",
  patch_repair_response: "patch_repair_response",
  usage_report: "usage_needed",
  usage_needed: "usage_needed",
  no_wiring_needed: "no_wiring_needed",
  completed: "completed",
  continue: "continue"
});

/** Convert an OpenAI Responses/tool-use result into the canonical Agent envelope. */
export function normalizeResponse(rawResponse, requestContext = {}) {
  const parentId = requestContext.request_id ?? requestContext.requestId;
  if (!isUuid(parentId)) {
    throw providerError("PROVIDER_CONTEXT_INVALID", "OpenAI response normalization requires a valid request_id.");
  }

  const tool = findToolCall(rawResponse) ?? findToolCall(rawResponse?.payload);
  if (!tool) {
    const structured = parseStructuredOutput(rawResponse);
    if (structured !== null) return normalizeStructuredOutput(structured, parentId, requestContext.expected_type);
  }
  if (!tool) throw providerError("PROVIDER_RESPONSE_INVALID", "OpenAI response contains no function call.");

  let payload = parseArguments(tool);
  const toolName = tool.name === "agent_tool" ? payload.kind : tool.name;
  const type = TOOL_TYPES[toolName];
  if (tool.name === "agent_tool" || toolName === "submit_code_response") payload = canonicalizeAgentToolPayload(payload, toolName);
  if (!type) throw providerError("PROVIDER_TOOL_UNSUPPORTED", `Unsupported OpenAI tool: ${tool.name || "<unknown>"}${tool.name === "agent_tool" ? ` (kind: ${payload.kind || "<missing>"})` : ""}.`);
  const envelope = {
    request_id: randomUUID(),
    parent_id: parentId,
    type,
    role: "agent",
    payload,
    timestamp: new Date().toISOString()
  };

  try {
    return assertValidEnvelope(envelope);
  } catch (error) {
    const detail = error?.message ? ` ${error.message}` : "";
    throw providerError("PROVIDER_PAYLOAD_INVALID", `OpenAI tool ${tool.name} returned an invalid payload.${detail}`, error);
  }
}

function normalizeStructuredOutput(payload, parentId, expectedType) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw providerError("PROVIDER_PAYLOAD_INVALID", "OpenAI structured output must be a JSON object.");
  const type = payload.type ?? payload.kind ?? (Array.isArray(expectedType) ? expectedType[0] : expectedType);
  if (!type) throw providerError("PROVIDER_PAYLOAD_INVALID", "OpenAI structured output is missing response type.");
  const canonicalType = TOOL_TYPES[type] ?? type;
  if (!TOOL_TYPES[type] && !TOOL_TYPES[canonicalType]) throw providerError("PROVIDER_TOOL_UNSUPPORTED", `Unsupported OpenAI structured output type: ${type}.`);
  const canonicalPayload = payload.payload ?? payload;
  if (canonicalPayload === payload) {
    delete canonicalPayload.type;
    delete canonicalPayload.kind;
  }
  const envelope = { request_id: randomUUID(), parent_id: parentId, type: canonicalType, role: "agent", payload: canonicalPayload, timestamp: new Date().toISOString() };
  try { return assertValidEnvelope(envelope); } catch (error) { throw providerError("PROVIDER_PAYLOAD_INVALID", `OpenAI structured output is invalid. ${error.message}`, error); }
}

function parseStructuredOutput(response) {
  const text = response?.output_text ?? response?.payload?.text;
  if (typeof text !== "string" || !text.trim()) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function canonicalizeAgentToolPayload(payload, toolName) {
  const canonical = { ...payload };
  for (const field of ["kind", "tool", "round", "max_rounds", "next_action", "is_final", "target_dir", "file_operation", "code_kind", "module_system", "change_summary", "allowed_change_areas", "checksum"]) delete canonical[field];
  if (toolName === "code_needed" && !canonical.files_requested && payload.target_path) canonical.files_requested = [payload.target_path];
  if (toolName === "code_needed") {
    delete canonical.query;
    delete canonical.target_path;
  }
  if (toolName === "submit_code_response") {
    const sourceFiles = Array.isArray(payload.files) ? payload.files : [payload];
    const files = sourceFiles.map((file) => ({
      path: file.path ?? file.target_path,
      format: file.format === "full" ? "full_content" : (file.format ?? file.change_format ?? "full_content"),
      content: file.content ?? "",
      exists: typeof file.exists === "boolean" ? file.exists : (file.before_checksum === null || file.file_operation === "create" ? false : true),
      before_checksum: file.before_checksum ?? (file.exists === false || file.file_operation === "create" ? null : file.checksum ?? null),
      ...(typeof file.summary === "string" ? { summary: file.summary } : {})
    }));
    return { explanation: typeof payload.explanation === "string" ? payload.explanation : "", files };
  }
  return canonical;
}

function findToolCall(response) {
  if (response?.tool_use) return normalizeTool(response.tool_use);
  if (response?.output?.length) {
    const item = response.output.find((entry) => entry?.type === "function_call" || entry?.type === "tool_use");
    if (item) return normalizeTool(item);
  }
  const call = response?.choices?.[0]?.message?.tool_calls?.[0];
  if (call) return normalizeTool(call.function ?? call);
  return null;
}

function normalizeTool(tool) {
  return { name: tool.name, arguments: tool.arguments ?? tool.input ?? {} };
}

function parseArguments(tool) {
  if (tool.arguments && typeof tool.arguments === "object" && !Array.isArray(tool.arguments)) return tool.arguments;
  if (typeof tool.arguments !== "string") throw providerError("PROVIDER_TOOL_ARGUMENTS_INVALID", "OpenAI tool arguments must be a JSON object.");
  try {
    const parsed = JSON.parse(tool.arguments);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw providerError("PROVIDER_TOOL_ARGUMENTS_INVALID", "OpenAI tool arguments are not valid JSON.", error);
  }
}

function providerError(code, message, cause) {
  const error = new ConfigurationError(`${code}: ${message}`, cause ? { cause } : undefined);
  error.providerCode = code;
  return error;
}

function isUuid(value) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

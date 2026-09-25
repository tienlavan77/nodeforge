// Normalizes Claude and Codex SDK events into governed Forge tool results.
import { ConfigurationError } from "../../shared/errors.js";

// Converts completed Codex SDK MCP events into Forge tool-event records.
export function sdkToolEvent(event, forgeToolNames) {
  if (event?.type !== "item.completed") return null;
  const item = event.item;
  if (!item || !["mcp_tool_call", "mcp_tool_result", "tool_use", "tool_result"].includes(item.type)) return null;
  const tool = normalizeForgeToolName(item.name ?? item.tool_name ?? item.tool);
  if (!tool || (forgeToolNames && !forgeToolNames.has(tool)) || (item.server && item.server !== "forge")) return null;
  const failed = item.status === "failed" || item.is_error === true || item.error != null;
  return {
    status: failed ? "failed" : "success",
    server: "forge",
    tool,
    item_id: item.call_id ?? item.id ?? null,
    arguments: diagnosticValue(item.arguments ?? item.input),
    result: diagnosticValue(item.result ?? item.output),
    error: diagnosticValue(item.error),
    error_code: extractResultErrorCode(item)
  };
}

// Validates that governed tools completed a ticket and reports stable errors.
export function assertTicketExecutionCompleted(toolEvents, { labMode = false, missingCode = "TOOL_EXECUTION_FAILED" } = {}) {
  if (!Array.isArray(toolEvents) || toolEvents.length === 0) throw Object.assign(new ConfigurationError("Agent did not expose Forge tool calls to the session."), { code: missingCode });
  const successful = toolEvents.filter((event) => event.status !== "failed");
  const names = successful.map((event) => event.name ?? event.tool);
  const failedReport = [...toolEvents].reverse().find((event) => (event.name ?? event.tool) === "report_done" && event.status === "failed");
  if (!names.includes("report_done")) {
    if (failedReport) {
      const code = failedReport.error_code ?? failedReport.error?.code ?? "REPORT_FAILED";
      const message = failedReport.error?.message ?? `Agent completion report failed (${code}).`;
      throw Object.assign(new ConfigurationError(message), { code });
    }
    throw Object.assign(new ConfigurationError("Agent ended without recording a completion report."), { code: "AGENT_REPORT_MISSING", tool: "report_done" });
  }
  if (labMode) return;
  const applied = names.includes("write_diff") || names.includes("edit_diff");
  const inspected = names.includes("read_file") || names.includes("search_code");
  const emptyCommit = toolEvents.some((event) =>
    (event.name ?? event.tool) === "commit_changes" && event.status === "failed" && event.error_code === "GIT_EMPTY_COMMIT"
  );
  if (applied && emptyCommit) return;
  if ((!applied || !names.includes("commit_changes")) && !(inspected && emptyCommit)) {
    throw Object.assign(new ConfigurationError("Agent ended without applying and committing ticket changes."), { code: "AGENT_CHANGES_MISSING", tool: applied ? "commit_changes" : "write_diff" });
  }
}

// Collects Claude SDK calls and their matching tool results.
export function collectToolCalls(messages) {
  const raw = messages.flatMap(extractToolEvents);
  const failedIds = new Set(raw.filter((item) => item.type === "tool_result" && item.is_error).map((item) => item.id).filter(Boolean));
  const resultsById = new Map(raw.filter((item) => item.type === "tool_result" && item.id).map((item) => [item.id, item]));
  return raw.filter((item) => item.type === "tool_use").map((item) => ({
    ...item,
    status: failedIds.has(item.id) ? "failed" : "success",
    error_code: resultsById.get(item.id)?.error_code ?? null,
    tool: item.name
  }));
}

// Extracts nested Claude tool-use and tool-result content blocks.
function extractToolEvents(message) {
  const blocks = [message?.content, message?.message?.content, message?.message, message].flatMap((value) => Array.isArray(value) ? value : [value]);
  return blocks.filter((item) => item?.type === "tool_use" || item?.type === "tool_result")
    .map((item) => ({ type: item.type, id: item.id ?? item.tool_use_id ?? null, is_error: item.is_error === true, error_code: normalizeToolErrorCode(item), name: normalizeForgeToolName(item.name ?? item.tool_name), tool_name: item.name ?? item.tool_name ?? null }));
}

// Extracts structured error codes returned by SDK MCP tools.
function extractResultErrorCode(item) {
  if (typeof item?.error_code === "string") return item.error_code;
  if (typeof item?.error?.code === "string") return item.error.code;
  const content = Array.isArray(item?.result?.content) ? item.result.content : [];
  const text = content.find((part) => typeof part?.text === "string")?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.error_code === "string" ? parsed.error_code : null;
  // eslint-disable-next-line no-silent-catch -- Error-code probe: non-JSON content means no structured code.
  } catch {
    return null;
  }
}

// Extracts structured error codes from Claude tool-result blocks.
function normalizeToolErrorCode(block) {
  if (typeof block?.error_code === "string") return block.error_code;
  if (typeof block?.error?.code === "string") return block.error.code;
  const content = Array.isArray(block?.content) ? block.content : [];
  const text = content.find((part) => typeof part?.text === "string")?.text;
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed?.error_code === "string" ? parsed.error_code : null;
  // eslint-disable-next-line no-silent-catch -- Error-code probe: non-JSON content means no structured code.
  } catch {
    return null;
  }
}

// Normalizes tool names exposed with or without the Forge MCP prefix.
function normalizeForgeToolName(name) {
  return typeof name === "string" ? name.replace(/^mcp__forge__/, "") : null;
}

// Bounds tool diagnostics and redacts potentially large content payloads.
function diagnosticValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "string") return value.length > 2000 ? `${value.slice(0, 2000)}...[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(diagnosticValue);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, key === "content" && typeof item === "string" ? `<redacted:${item.length} chars>` : diagnosticValue(item)]));
  return value;
}

// Reads text from nested SDK response structures.
export function extractText(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractText);
  if (!value || typeof value !== "object") return [];
  if (typeof value.text === "string") return [value.text];
  return Object.entries(value).flatMap(([key, item]) => ["message", "content", "output"].includes(key) ? extractText(item) : []);
}

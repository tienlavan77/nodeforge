// Formats bounded Forge tool telemetry for project logs and terminal hints.
import { resultCount } from "./tool-result-count.js";

// Selects paths from bounded discovery results for audit metadata.
function selectedPaths(items) {
  if (!Array.isArray(items) || !items.length) return [];
  return items.map((item) => item?.path).filter(Boolean);
}

// Summarizes discovered paths on the operator terminal.
export function pathHint(items) {
  const paths = selectedPaths(items);
  if (!paths.length) return "0-results";
  return paths.slice(0, 4).join(",").slice(0, 100);
}

// Discovery detail is shared by the terminal line and project.log so an
// operator can audit what each search query/context actually returned.
// Describes which query returned the paths without logging source content.
function discoveryDetail(name, input = {}, result) {
  if (!result || typeof result !== "object") return null;
  if (name === "select_code_graph_candidates") {
    return { query: input.query ?? "", context: input.context ?? "", result_paths: selectedPaths(result.selected) };
  }
  if (name === "search_code") {
    return { query: input.query ?? "", kind: input.kind ?? "", result_paths: selectedPaths(result.matches) };
  }
  return null;
}

// Builds a project log event for a Forge tool invocation.
export function formatToolLogEvent(status, tool, input, context, extra) {
  const taskId = context.task_id ?? context.taskId ?? `TOOL-${tool}`;
  const executionId = context.execution_id ?? context.executionId;
  const payload = {
    tool,
    ...(executionId ? { execution_id: executionId } : {}),
    ...(context.agent_identity?.agent_id ? { agent_id: context.agent_identity.agent_id } : {}),
    ...(context.session_id ? { session_id: context.session_id } : {}),
    ...(extra.duration_ms !== undefined ? { duration_ms: extra.duration_ms } : {})
  };
  if (status === "failed") {
    payload.error_code = extra.error?.code ?? "TOOL_EXECUTION_FAILED";
    if (extra.error?.details && typeof extra.error.details === "object") {
      Object.assign(payload, extra.error.details);
    }
  }
  if (status === "success" && ["Read", "Glob", "Grep"].includes(tool)) payload.result = { count: resultCount(tool, extra.result) ?? 0, truncated: extra.result?.truncated === true };
  const detail = status === "success" ? discoveryDetail(tool, input, extra.result) : null;
  if (detail) {
    payload.discovery = { ...detail, result_count: detail.result_paths.length, result_summary: detail.result_paths.length ? detail.result_paths.slice(0, 4).join(",") : "0-results" };
  }
  const message = detail
    ? `Forge tool ${tool} ${status} q="${String(detail.query ?? "").slice(0, 60)}"${detail.context !== undefined ? ` ctx="${String(detail.context).slice(0, 60)}"` : ""} -> ${detail.result_paths.length ? detail.result_paths.slice(0, 4).join(", ") : "0-results"}`
    : `Forge tool ${tool} ${status}.`;
  return {
    timestamp: new Date().toISOString(),
    event_name: `forge.tool_${status}`,
    level: status === "failed" ? "error" : "info",
    status,
    message,
    task_id: taskId,
    ...(context.ticket?.id ? { ticket_id: context.ticket.id } : {}),
    ...(context.correlation_id ? { correlation_id: context.correlation_id } : {}),
    source: "forge-tool-registry",
    ...(status === "failed" ? { error_code: payload.error_code } : {}),
    payload
  };
}

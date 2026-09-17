// Formats structured runtime events into persisted project log entries and condensed human-readable terminal lines.
import process from "node:process";

const SYMBOLS = { success: "OK", failed: "FAIL", error: "ERR", warn: "WARN", started: "GO", info: "--", debug: ".." };

// The per-tool [agent]/[forge] terminal line already announces each tool call's
// start and success, so these duplicate supervisor human lines are not printed.
// The events are still persisted to project.log (only stdout is suppressed).
const SUPPRESSED_HUMAN_EVENTS = new Set(["forge.tool_started", "forge.tool_success"]);

// Formats a project log entry into a single human-readable terminal line with UTC time, status symbol, and ticket/tool context.
function humanLine(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString("en-GB", { hour12: false, timeZone: "UTC" });
  const symbol = SYMBOLS[entry.error_code ? "error" : entry.status] ?? "--";
  const agent = entry.payload?.agent_name ?? entry.payload?.agent_id;
  const tool = entry.payload?.tool;
  const ticket = shortTicket(entry.task_id);
  if (entry.event_name === "supervisor.tool_ticket_failed" && tool) {
    const bits = [`${agent ? `[${agent}]` : "[forge]"} ${tool} FAIL`];
    if (entry.error_code) bits.push(`(${entry.error_code})`);
    if (ticket) bits.push(`{${ticket}}`);
    return `[${time}] ${symbol.padEnd(4)} ${bits.join(" ")}`;
  }
  const bits = [entry.message];
  if (agent) bits.push(`<${agent}>`);
  if (tool) bits.push(`[${tool}]`);
  if (entry.error_code) bits.push(`(${entry.error_code})`);
  if (ticket) bits.push(`{${ticket}}`);
  return `[${time}] ${symbol.padEnd(4)} ${bits.join(" ")}`;
}

// Shortens a task/ticket id to a compact label for human log lines.
function shortTicket(taskId) {
  if (typeof taskId !== "string") return null;
  const match = taskId.match(/(?:TICKET|TASK|REQ|SUP)-?(.{3,20})$/);
  return match ? match[1] : (taskId.length > 24 ? `${taskId.slice(0, 12)}…` : taskId);
}

// Creates a runtime logger that normalizes event fields, persists via logEvent, and writes filtered human lines to output.
export function createRuntimeLogger({ logEvent, output = process.stdout, source = "nodeforge-runtime" } = {}) {
  const emit = (entry = {}) => {
    const {
      timestamp, event_name, level, status, message, task_id, ticket_id,
      conversation_id, correlation_id, exit_code, error_code,
      source: entrySource, payload, ...extras
    } = entry;
    const name = typeof event_name === "string" && event_name ? event_name : "runtime.event";
    const resolvedStatus = status ?? "info";
    const text = typeof message === "string" && message ? message : name;
    const resolvedPayload = {
      ...(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : payload !== undefined ? { value: payload } : {}),
      ...extras
    };
    const normalized = {
      timestamp: timestamp ?? new Date().toISOString(),
      level: level ?? statusLevel(resolvedStatus),
      event_name: name,
      status: resolvedStatus,
      task_id: typeof task_id === "string" && task_id ? task_id : `RUNTIME-${name}`,
      request_id: resolvedPayload.request_id ?? null,
      correlation_id: correlation_id ?? null,
      source: entrySource ?? source,
      message: text,
      ...(error_code || resolvedPayload.error_code ? { error_code: error_code ?? resolvedPayload.error_code } : {}),
      ...(Object.keys(resolvedPayload).length > 0 ? { payload: resolvedPayload } : {})
    };
    try {
      // The project-log schema is additionalProperties:false — only schema
      // fields may be passed through; unknown detail keys live in payload.
      logEvent?.({
        timestamp: normalized.timestamp,
        event_name: normalized.event_name,
        level: normalized.level,
        status: normalized.status,
        message: normalized.message,
        task_id: normalized.task_id,
        source: normalized.source,
        ...(ticket_id ? { ticket_id } : {}),
        ...(conversation_id ? { conversation_id } : {}),
        ...(normalized.correlation_id ? { correlation_id: normalized.correlation_id } : {}),
        ...(normalized.error_code ? { error_code: normalized.error_code } : {}),
        ...(exit_code !== undefined ? { exit_code } : {}),
        ...(Object.keys(resolvedPayload).length > 0 ? { payload: resolvedPayload } : {})
      });
    } catch (error) {
      normalized.log_persist_error = error.message;
    }
    if (normalized.level === "debug") return normalized;
    // The [forge]/[agent] tool line already reports started/success/failure per
    // tool call, so suppress the duplicate supervisor forge.tool_* human lines.
    // They are still persisted to project.log above.
    if (SUPPRESSED_HUMAN_EVENTS.has(normalized.event_name)) return normalized;
    const human = humanLine(normalized);
    output.write(human.length > 220 ? `${human.slice(0, 217)}…\n` : `${human}\n`);
    return normalized;
  };

  return {
    emit,
    debug(message, details = {}) { emit({ ...details, level: "debug", status: "info", message }); },
    info(message, details = {}) { emit({ ...details, level: "info", status: details.status ?? "info", message }); },
    error(message, details = {}) { emit({ ...details, level: "error", status: "failed", message }); }
  };
}

// Maps a task status to its corresponding log level (error for failed, info otherwise).
function statusLevel(status) { return status === "failed" ? "error" : "info"; }

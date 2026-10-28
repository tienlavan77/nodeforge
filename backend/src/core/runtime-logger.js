// Formats structured runtime events into persisted project log entries and condensed human-readable terminal lines.
import process from "node:process";

import { createTerminalEventWriter } from "./terminal-event-writer.js";

// Creates a runtime logger that normalizes event fields, persists via logEvent, and writes filtered human lines to output.
export function createRuntimeLogger({ logEvent, output = process.stdout, source = "nodeforge-runtime" } = {}) {
  const writeTerminal = createTerminalEventWriter(output);
  // Defines emit function behavior for runtime-logger.js.
  const emit = (entry = {}) => {
    const {
      timestamp, event_name, level, status, message, task_id, ticket_id,
      conversation_id, correlation_id, exit_code, error_code, project_id,
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
      ...(ticket_id ? { ticket_id } : {}),
      ...(conversation_id ? { conversation_id } : {}),
      ...(project_id !== undefined ? { project_id } : {}),
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
        ...(project_id !== undefined ? { project_id } : {}),
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
    writeTerminal(normalized);
    return normalized;
  };

  return {
    emit,
    // Defines debug method behavior for runtime-logger.js.
    debug(message, details = {}) { emit({ ...details, level: "debug", status: "info", message }); },
    // Defines info method behavior for runtime-logger.js.
    info(message, details = {}) { emit({ ...details, level: "info", status: details.status ?? "info", message }); },
    // Defines error method behavior for runtime-logger.js.
    error(message, details = {}) { emit({ ...details, level: "error", status: "failed", message }); }
  };
}

// Maps a task status to its corresponding log level (error for failed, info otherwise).
function statusLevel(status) { return status === "failed" ? "error" : "info"; }

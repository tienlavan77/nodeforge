import process from "node:process";

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
    output.write(`[nodeforge] ${JSON.stringify(normalized)}\n`);
    return normalized;
  };

  return {
    emit,
    debug(message, details = {}) { emit({ ...details, level: "debug", status: "info", message }); },
    info(message, details = {}) { emit({ ...details, level: "info", status: details.status ?? "info", message }); },
    error(message, details = {}) { emit({ ...details, level: "error", status: "failed", message }); }
  };
}

function statusLevel(status) { return status === "failed" ? "error" : "info"; }

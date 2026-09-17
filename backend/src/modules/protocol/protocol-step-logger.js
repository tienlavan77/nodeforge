// Structured logger for Node-Agent protocol step lifecycle events.
import { ConfigurationError } from "../../shared/errors.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Operational metadata logger for one Node-Agent protocol step. */
// Creates a structured logger for protocol step events.
export function createProtocolStepLogger({ logger = console, clock = () => new Date() } = {}) {
  if (!logger || typeof logger.info !== "function" || typeof logger.error !== "function") throw new ConfigurationError("Protocol Step Logger requires info and error methods.");
  if (typeof clock !== "function") throw new ConfigurationError("Protocol Step Logger clock must be a function.");

  return Object.freeze({ requestSent, responseReceived, responsePersistFailed, failed });

  // Logs a request_sent protocol step.
  function requestSent(context) { return write("request_sent", "info", context, { status: "sent" }); }
  // Logs a response_received protocol step.
  function responseReceived(context) { return write("response_received", "info", context); }
  // Logs a response persistence failure.
  function responsePersistFailed(context) { return write("response_persist_failed", "error", context, { status: "failed" }); }
  // Logs a generic step failure.
  function failed(context) { return write("step_failed", "error", context, { status: "failed" }); }

  // Normalizes context and writes the log entry at the chosen level.
  function write(event, level, context = {}, defaults = {}) {
    const record = normalize(event, context, defaults);
    logger[level]("Node-Agent protocol step", record);
    return record;
  }

  // Validates required fields and builds a frozen log record.
  function normalize(event, context, defaults) {
    if (!context || typeof context !== "object") throw new ConfigurationError("Protocol log context must be an object.");
    for (const field of ["task_id", "step_id", "type", "role", "request_id"]) {
      if (context[field] === undefined || context[field] === null || context[field] === "") throw new ConfigurationError(`Protocol log requires ${field}.`);
    }
    if (!Number.isInteger(context.step_id) || context.step_id < 1) throw new ConfigurationError("Protocol log step_id must be a positive integer.");
    if (!UUID.test(context.request_id)) throw new ConfigurationError("Protocol log request_id must be a UUID.");
    if (context.parent_id !== null && context.parent_id !== undefined && !UUID.test(context.parent_id)) throw new ConfigurationError("Protocol log parent_id must be a UUID or null.");
    if (context.duration_ms !== undefined && (!Number.isFinite(context.duration_ms) || context.duration_ms < 0)) throw new ConfigurationError("Protocol log duration_ms must be a non-negative number.");
    if (context.error_code !== undefined && (typeof context.error_code !== "string" || !context.error_code)) throw new ConfigurationError("Protocol log error_code must be a non-empty string.");
    if (context.error_message !== undefined && (typeof context.error_message !== "string" || !context.error_message)) throw new ConfigurationError("Protocol log error_message must be a non-empty string.");
    if (context.payload !== undefined || context.body !== undefined || context.transcript !== undefined) throw new ConfigurationError("Protocol log accepts metadata only; store payload in Protocol Storage.");
    return Object.freeze({
      event,
      timestamp: clock().toISOString(),
      task_id: String(context.task_id),
      step_id: context.step_id,
      type: String(context.type),
      role: String(context.role),
      request_id: context.request_id,
      parent_id: context.parent_id ?? null,
      ...(context.duration_ms !== undefined ? { duration_ms: context.duration_ms } : {}),
      ...(context.error_code !== undefined ? { error_code: context.error_code } : {}),
      ...(context.error_message !== undefined ? { error_message: context.error_message } : {}),
      status: defaults.status ?? context.status ?? "received"
    });
  }
}

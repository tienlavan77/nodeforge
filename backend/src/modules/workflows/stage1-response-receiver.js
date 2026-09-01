import { ConfigurationError } from "../../shared/errors.js";
import { assertValidEnvelope } from "../protocol/envelope-validator.js";

/** Validate one normalized Agent response and emit the shared response log. */
export function createStage1ResponseReceiver({ protocolLogger, validator = assertValidEnvelope } = {}) {
  if (!protocolLogger || typeof protocolLogger.responseReceived !== "function" || typeof protocolLogger.failed !== "function") throw new ConfigurationError("Stage-1 response receiver requires a Protocol Step Logger.");
  if (typeof validator !== "function") throw new ConfigurationError("Stage-1 response receiver validator must be a function.");
  return Object.freeze({ receiveResponse });

  function receiveResponse(rawEnvelope, { requestEnvelope, startedAt = Date.now() } = {}) {
    if (!requestEnvelope || typeof requestEnvelope !== "object") throw new ConfigurationError("Stage-1 response receiver requires the request envelope.");
    const context = {
      task_id: requestEnvelope.payload?.task_id,
      step_id: requestEnvelope.payload?.step_id,
      type: rawEnvelope?.type,
      role: rawEnvelope?.role,
      request_id: rawEnvelope?.request_id,
      parent_id: rawEnvelope?.parent_id,
      duration_ms: Math.max(0, Date.now() - startedAt)
    };
    try {
      if (rawEnvelope?.role !== "agent") throw responseError("RESPONSE_ROLE_INVALID", "Agent response must have role=agent.");
      if (rawEnvelope?.parent_id !== requestEnvelope.request_id) throw responseError("RESPONSE_PARENT_MISMATCH", "Agent response parent_id does not match the request.");
      const envelope = validator(rawEnvelope);
      protocolLogger.responseReceived({ ...context, type: envelope.type, role: envelope.role, request_id: envelope.request_id, parent_id: envelope.parent_id, status: "received" });
      return envelope;
    } catch (error) {
      protocolLogger.failed({ ...context, status: "failed" });
      throw error;
    }
  }
}

function responseError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

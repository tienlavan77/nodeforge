import { ConfigurationError } from "../../shared/errors.js";

/** Route validated Agent responses to the stage-1 branch handlers. */
export function createStage1ResponseRouter({ onCodeNeeded, onSubmitCode, onUsageNeeded = defaultUsageNeeded, onNoWiringNeeded = defaultNoWiringNeeded } = {}) {
  if (typeof onCodeNeeded !== "function" || typeof onSubmitCode !== "function") throw new ConfigurationError("Stage-1 response router requires code_needed and submit_code handlers.");
  return Object.freeze({ routeResponse });

  async function routeResponse(envelope, context = {}) {
    if (!envelope || envelope.role !== "agent" || typeof envelope.type !== "string") throw routeError("RESPONSE_INVALID", "Stage-1 router requires a validated Agent envelope.");
    if (envelope.type === "code_needed") return onCodeNeeded(envelope, context);
    if (envelope.type === "submit_code_response") return onSubmitCode(envelope, context);
    if (envelope.type === "usage_needed") return onUsageNeeded(envelope, context);
    if (envelope.type === "no_wiring_needed") return onNoWiringNeeded(envelope, context);
    throw routeError("RESPONSE_TYPE_UNSUPPORTED", `Stage-1 router does not support response type: ${envelope.type}.`);
  }
}

function defaultUsageNeeded(envelope) { return Object.freeze({ type: "usage_needed", files_requested: [...envelope.payload.files_requested], reason: envelope.payload.reason }); }
function defaultNoWiringNeeded(envelope) { return Object.freeze({ type: "no_wiring_needed", reason: envelope.payload.reason }); }

function routeError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

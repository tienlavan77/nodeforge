import { ConfigurationError } from "../../shared/errors.js";
import { getAdapter } from "../agent/provider-adapters/index.js";

/** Sends one canonical task envelope through the provider selected by profile. */
export function createStage1RequestSender({ adapterResolver = getAdapter, protocolLogger, protocolStorage } = {}) {
  if (typeof adapterResolver !== "function") throw new ConfigurationError("Stage-1 request sender requires an adapter resolver.");
  if (!protocolLogger || typeof protocolLogger.requestSent !== "function" || typeof protocolLogger.failed !== "function") throw new ConfigurationError("Stage-1 request sender requires a Protocol Step Logger.");
  if (protocolStorage !== undefined && typeof protocolStorage.save !== "function") throw new ConfigurationError("Stage-1 request sender requires valid Protocol Storage.");
  return Object.freeze({ sendRequest });

  async function sendRequest(envelope, { agentProfile, credential, url, signal, correlationId } = {}) {
    assertEnvelope(envelope);
    const provider = agentProfile?.provider ?? "openai";
    const adapter = adapterResolver(provider);
    if (typeof adapter?.call !== "function") throw new ConfigurationError(`Provider adapter does not implement call(): ${provider}.`);
    const context = { task_id: envelope.payload.task_id, step_id: envelope.payload.step_id, type: envelope.type, role: envelope.role, request_id: envelope.request_id, parent_id: envelope.parent_id };
    const started = Date.now();
    protocolLogger.requestSent(context);
    const requestRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/request`;
    try {
      await protocolStorage?.save(requestRef, envelope, { schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
      const providerPayload = buildProviderPayload(envelope);
      let response;
      try {
        response = await adapter.call({ payload: providerPayload, url: url ?? agentProfile?.gateway_url, credential, model: agentProfile?.model, correlationId: correlationId ?? envelope.payload.metadata?.correlation_id, signal });
      } catch (error) {
        const rawResponse = error?.rawResponse;
        if (rawResponse !== undefined) {
          const responseRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/response`;
          await protocolStorage?.save(responseRef, rawResponse, { schemaId: "https://forge.local/schemas/agent/raw-response.json" }).catch(() => {});
        }
        throw error;
      }
      const responseRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/response`;
      await protocolStorage?.save(responseRef, response, { schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
      return Object.freeze({ response, request_ref: requestRef, response_ref: responseRef, duration_ms: Date.now() - started });
    } catch (error) {
      protocolLogger.failed({ ...context, duration_ms: Date.now() - started, status: "failed" });
      throw error;
    }
  }
}

function assertEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || !["task", "code_provide", "usage_query", "status_check"].includes(envelope.type) || envelope.role !== "node" || typeof envelope.request_id !== "string" || !envelope.payload || typeof envelope.payload.task_id !== "string" || !Number.isInteger(envelope.payload.step_id)) throw new ConfigurationError("Stage-1 sender requires a valid node task/code_provide envelope.");
}

function buildProviderPayload(envelope) {
  const payload = { ...envelope.payload, request_id: envelope.request_id };
  if (envelope.type === "usage_query") return { ...payload, expected_output: { type: "usage_response", representation: "json", transport: "function_tool" } };
  if (envelope.type === "status_check") return { ...payload, expected_output: { type: "status_response", representation: "json", transport: "function_tool" } };
  if (envelope.type !== "code_provide") {
    // The first task round only requests context; code submission is opened
    // after Node sends the requested file contents in a code_provide round.
    return {
      ...payload,
      expected_output: { type: "code_needed", representation: "json", transport: "function_tool" }
    };
  }
  const files = Array.isArray(envelope.payload.files) ? envelope.payload.files.map(stripInternalFileFields) : envelope.payload.files;
  if (!Array.isArray(files) || files.length === 0) throw new ConfigurationError("code_provide payload requires files.");
  return {
    ...payload,
    instruction_blocks: payload.task_context?.instruction_blocks ?? [],
    user_blocks: [
      ...(payload.task_context?.user_blocks ?? []),
      { block_id: "code_provide", content: `${JSON.stringify({ files })}\n\nApply the requested ticket change now. Return submit_code_response with representation=full_content for every file and the complete file contents, not a stub or unchanged placeholder. For exists=true, copy before_checksum exactly from the provided file context; for exists=false use before_checksum=null and include a concise one-line summary (1-160 characters) describing the new file's responsibility; Node will insert the summary comment.`, cacheable: false }
    ],
    expected_output: { type: "submit_code_response", representation: "full_content", transport: "function_tool" }
  };
}

function stripInternalFileFields(file = {}) {
  const rest = { ...file };
  delete rest.index;
  return rest;
}

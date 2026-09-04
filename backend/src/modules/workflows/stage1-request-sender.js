import { ConfigurationError } from "../../shared/errors.js";
import { getAdapter } from "../agent/provider-adapters/index.js";
import { STRUCTURED_PATCH_PROMPT } from "./structured-patch-prompt.js";
import { CODE_REQUIRE_INSTRUCTION } from "./stage1-instructions.js";

/** Sends one canonical task envelope through the provider selected by profile. */
export function createStage1RequestSender({ adapterResolver = getAdapter, protocolLogger, protocolStorage, roundCounter, onRoundLimit } = {}) {
  if (typeof adapterResolver !== "function") throw new ConfigurationError("Stage-1 request sender requires an adapter resolver.");
  if (!protocolLogger || typeof protocolLogger.requestSent !== "function" || typeof protocolLogger.failed !== "function") throw new ConfigurationError("Stage-1 request sender requires a Protocol Step Logger.");
  if (protocolStorage !== undefined && typeof protocolStorage.save !== "function") throw new ConfigurationError("Stage-1 request sender requires valid Protocol Storage.");
  return Object.freeze({ sendRequest });

  async function sendRequest(envelope, { agentProfile, credential, url, signal, correlationId } = {}) {
    assertEnvelope(envelope);
    const round = roundCounter?.increment(envelope.payload.task_id);
    if (round && !round.allowed) {
      await onRoundLimit?.(round, envelope);
      const error = new ConfigurationError(`Round limit exceeded for ${round.task_id}: ${round.count}/${round.max_rounds}.`);
      error.code = "ROUND_LIMIT_EXCEEDED";
      throw error;
    }
    const provider = agentProfile?.provider ?? "openai";
    const adapter = adapterResolver(provider);
    if (typeof adapter?.call !== "function") throw new ConfigurationError(`Provider adapter does not implement call(): ${provider}.`);
    const context = { task_id: envelope.payload.task_id, step_id: envelope.payload.step_id, type: envelope.type, role: envelope.role, request_id: envelope.request_id, parent_id: envelope.parent_id };
    const started = Date.now();
    protocolLogger.requestSent(context);
    const requestRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/request`;
    try {
      await protocolStorage?.save(requestRef, envelope, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
      const providerPayload = buildProviderPayload(envelope);
      let response;
      try {
        response = await adapter.call({ payload: providerPayload, url: url ?? agentProfile?.gateway_url, credential, model: agentProfile?.model, correlationId: correlationId ?? envelope.payload.metadata?.correlation_id, signal });
      } catch (error) {
        const rawResponse = error?.rawResponse;
        if (rawResponse !== undefined) {
          const responseRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/response`;
          await persistResponseOrStop(responseRef, rawResponse, context, started);
        }
        throw error;
      }
      const responseRef = `task/${envelope.payload.task_id}/round_${envelope.payload.step_id}/response`;
      await protocolStorage?.save(responseRef, response, { replace: true, schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
      if (response?.provider_metadata) {
        protocolLogger.responseReceived({ ...context, provider: response.provider_metadata.provider, provider_response_id: response.provider_metadata.response_id, provider_status: response.provider_metadata.status, completed_at: response.provider_metadata.completed_at, status: "received" });
      }
      return Object.freeze({ response, request_ref: requestRef, response_ref: responseRef, duration_ms: Date.now() - started, provider_metadata: response?.provider_metadata ?? null });
    } catch (error) {
      protocolLogger.failed({ ...context, duration_ms: Date.now() - started, status: "failed", error_code: error.code ?? "STAGE1_REQUEST_FAILED", error_message: error.message });
      throw error;
    }
  }

  async function persistResponseOrStop(responseRef, response, context, started) {
    if (!protocolStorage) return;
    try {
      await protocolStorage.save(responseRef, response, { schemaId: "https://forge.local/schemas/agent/raw-response.schema.json" });
    } catch (persistError) {
      const detail = { ...context, duration_ms: Date.now() - started, error_code: "PROTOCOL_RESPONSE_PERSIST_FAILED", error_message: persistError.message };
      if (typeof protocolLogger.responsePersistFailed === "function") protocolLogger.responsePersistFailed(detail);
      else protocolLogger.failed(detail);
      const failure = new ConfigurationError(`Unable to persist provider response: ${persistError.message}`);
      failure.code = "PROTOCOL_RESPONSE_PERSIST_FAILED";
      failure.cause = persistError;
      throw failure;
    }
  }
}

function assertEnvelope(envelope) {
  if (!envelope || typeof envelope !== "object" || !["task", "planning", "code_provide", "usage_query", "status_check"].includes(envelope.type) || envelope.role !== "node" || typeof envelope.request_id !== "string" || !envelope.payload || typeof envelope.payload.task_id !== "string" || !Number.isInteger(envelope.payload.step_id)) throw new ConfigurationError("Stage-1 sender requires a valid node task/code_provide envelope.");
}

function buildProviderPayload(envelope) {
  const payload = { ...envelope.payload, request_id: envelope.request_id };
  if (envelope.type === "usage_query") return { ...payload, expected_output: { type: "usage_response", representation: "json", transport: "function_tool" } };
  if (envelope.type === "status_check") return { ...payload, expected_output: { type: "status_response", representation: "json", transport: "function_tool" } };
  if (envelope.type === "planning") {
    const files = Array.isArray(envelope.payload.files) ? envelope.payload.files.map(stripInternalFileFields) : null;
    return { ...payload, files, instruction_blocks: payload.task_context?.instruction_blocks ?? [], user_blocks: [...(payload.task_context?.user_blocks ?? []), { block_id: "planning-context", content: JSON.stringify({ plan: payload.plan, files }), cacheable: false }], expected_output: { type: "planning", representation: "json", transport: "function_tool" } };
  }
  if (envelope.type !== "code_provide") return { ...payload, expected_output: { type: "code_needed", representation: "json", transport: "function_tool" } };

  const files = Array.isArray(envelope.payload.files) ? envelope.payload.files.map(stripInternalFileFields) : null;
  const formats = submissionFormatsFromPlan(payload.plan);
  const guidance = formats.has("structured_patch")
    ? `${STRUCTURED_PATCH_PROMPT}${formats.has("full_content") ? " For NEW files, use full_content with exists=false, before_checksum=null, complete string content, and a one-line summary." : ""}`
    : "For NEW files, return format=full_content, exists=false, before_checksum=null, complete file content as a string, and a one-line summary.";
  return {
    ...payload,
    instruction_blocks: [
      ...(payload.task_context?.instruction_blocks ?? []).filter((block) => !isLegacySubmissionInstruction(block)),
      { block_id: "code_require", content: CODE_REQUIRE_INSTRUCTION, cacheable: false },
      { block_id: "submission-contract", content: guidance, cacheable: true }
    ],
    user_blocks: [
      ...(payload.task_context?.user_blocks ?? []),
      ...(Array.isArray(payload.plan) ? [{ block_id: "execution-plan", content: JSON.stringify({ plan: payload.plan }), cacheable: false }] : []),
      ...(files?.length ? [{ block_id: "code_provide", content: `${JSON.stringify({ files })}\n\nApply the requested ticket change now. ${guidance}`, cacheable: false }] : [])
    ],
    expected_output: { type: "submit_code_response", transport: "function_tool" }
  };
}

function submissionFormatsFromPlan(plan) {
  const formats = new Set();
  for (const item of plan ?? []) {
    if (item?.action === "NEW") formats.add("full_content");
    if (item?.action === "MODIFY") formats.add("structured_patch");
  }
  if (formats.size === 0) throw new ConfigurationError("Round 3 plan requires at least one NEW or MODIFY item.");
  return formats;
}

function isLegacySubmissionInstruction(block = {}) {
  const content = String(block.content ?? "");
  return /Return\s+full_content\s+only\b/i.test(content)
    || /complete\s+(?:final\s+)?file\s+contents?/i.test(content)
    || /full\s+contents?\s+and\s+module_system/i.test(content);
}

function stripInternalFileFields(file = {}) {
  const rest = { ...file };
  delete rest.index;
  return rest;
}

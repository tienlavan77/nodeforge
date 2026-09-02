import { ConfigurationError } from "../../shared/errors.js";
import { getAdapter } from "../agent/provider-adapters/index.js";
import { requestedSubmissionFormat } from "./submission-format.js";

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
      await protocolStorage?.save(requestRef, envelope, { schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
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
      await protocolStorage?.save(responseRef, response, { schemaId: "https://forge.local/schemas/agent/envelope.schema.json" });
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
  const representation = requestedSubmissionFormat(envelope.payload);
  const guidance = representation === "unified_diff"
    ? "Return submit_code_response with format=unified_diff. Each existing file must contain a valid ---/+++ header, ranged @@ hunk, and context lines; do not use bare @@ or markdown fences."
    : representation === "apply_patch"
      ? "Return submit_code_response with format=apply_patch. Wrap each patch in *** Begin Patch/*** End Patch, use *** Update File: path and context lines; do not use unified diff headers."
      : representation === "structured_patch"
        ? 'STRUCTURED PATCH: Existing files only; use format=structured_patch and content={operations:[...]}. Allowed ops: replace_range(start_line,end_line,new_content), delete_range(start_line,end_line), insert_after(anchor_line,new_content), insert_at_end(new_content). Do not provide line numbers. Use only exact source content, expected_content, and anchor_text from the supplied file context; never guess or reconstruct them. For replace_range/delete_range provide expected_content exactly once; for insert_after provide anchor_text exactly once. Node locates these regions deterministically and rejects missing or ambiguous context before writing. Node applies operations sequentially and shifts later line/anchor coordinates automatically after each insert/delete/replace. Do not recompute coordinates yourself and do not overlap operations; Node rejects overlapping ranges. Use only Node-provided paths, lines, anchors, and context; never guess. New files require full_content. Copy before_checksum exactly; never calculate, alter, or omit it. Missing/stale/ambiguous context or checksum -> code_needed. No full files, diff/apply_patch text, placeholders, fences, or prose. Node validates, applies, syntax-checks, writes via File Service, and commits; reject the whole file if any operation fails. Return only the structured response tool.'
        : "Return submit_code_response with format=full_content and complete final file contents, not a stub or unchanged placeholder.";
  return {
    ...payload,
    instruction_blocks: payload.task_context?.instruction_blocks ?? [],
    user_blocks: [
      ...(payload.task_context?.user_blocks ?? []),
      { block_id: "code_provide", content: `${JSON.stringify({ files })}\n\nApply the requested ticket change now. ${guidance} For each file, inspect before_checksum: when it is null, you MUST use format=full_content with complete content; when it is a sha256 value, use the requested patch format and copy the checksum exactly. Include a concise one-line summary (1-160 characters) for new files; Node will insert the summary comment.`, cacheable: false }
    ],
    expected_output: { type: "submit_code_response", representation, transport: "function_tool" }
  };
}

function stripInternalFileFields(file = {}) {
  const rest = { ...file };
  delete rest.index;
  return rest;
}

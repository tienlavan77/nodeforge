// Builds OpenAI Responses requests from canonical payloads and normalizes the result envelope.
import * as codex from "./codex-adapter.js";
import { buildCacheOptions, buildInput, buildInstructions, buildResponseFormat, buildToolConfig } from "./openai-request-builder.js";
import { createOpenAITranscriptResolver } from "./openai-transcript-resolver.js";
import { normalizeResponse } from "./openai-response-normalizer.js";
import { ConfigurationError } from "../../../shared/errors.js";

/** Public OpenAI adapter entry point for the canonical generic payload. */
// Creates the canonical OpenAI adapter that resolves transcripts and normalizes envelopes.
export function createOpenAIAdapter({ storage, requestFn = codex.request } = {}) {
  const resolver = storage ? createOpenAITranscriptResolver({ storage }) : null;
  return Object.freeze({ call });

  async function call({ payload, url, credential, model, correlationId, signal } = {}) {
    const genericPayload = payload ?? {};
    if (genericPayload.transcript_blocks?.length && !resolver) throw new ConfigurationError("OpenAI adapter requires Protocol Storage for transcript blocks.");
    const transcript = genericPayload.transcript_blocks?.length
      ? await resolver.resolveTranscript(genericPayload)
      : [];
    const toolConfig = buildToolConfig(genericPayload);
    const transport = genericPayload.expected_output?.transport ?? genericPayload.expected_submission?.transport ?? "function_tool";
    const preparedRequest = {
      model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra",
      input: buildInput(genericPayload, transcript),
      instructions: buildInstructions(genericPayload),
      ...(transport === "json_schema" ? buildResponseFormat(genericPayload, toolConfig) : toolConfig),
      ...(buildCacheOptions(genericPayload) ?? {})
    };
    const raw = await requestFn({ url, credential, payload: genericPayload, preparedRequest, model, correlationId, signal });
    try {
      assertCompleted(raw);
      const envelope = normalizeResponse(raw.payload ?? raw, { request_id: genericPayload.request_id ?? genericPayload.requestId, expected_type: genericPayload.expected_output?.type ?? genericPayload.expected_submission?.type });
      Object.defineProperty(envelope, "provider_metadata", {
        value: Object.freeze({
          provider: "openai",
          response_id: raw?.payload?.response_id ?? raw?.response_id ?? null,
          status: raw?.status ?? "completed",
          completed_at: raw?.completed_at ?? null,
          error: raw?.error ?? null,
          incomplete_details: raw?.incomplete_details ?? null
        }),
        enumerable: false
      });
      return envelope;
    } catch (error) {
      // Sender persists the raw provider response before retrying validation.
      error.rawResponse = raw?.raw_response ?? raw;
      throw error;
    }
  }
}

// Throws for non-completed Responses statuses with typed error codes.
function assertCompleted(response) {
  const status = response?.status ?? "completed";
  switch (status) {
    case "completed":
      return;
    case "incomplete":
      throw providerStatusError("PROVIDER_RESPONSE_INCOMPLETE", status, response, response?.incomplete_details);
    case "failed":
      throw providerStatusError("PROVIDER_RESPONSE_FAILED", status, response, response?.error);
    case "cancelled":
      throw providerStatusError("PROVIDER_RESPONSE_CANCELLED", status, response);
    case "queued":
    case "in_progress":
      throw providerStatusError("PROVIDER_RESPONSE_NOT_READY", status, response);
    default:
      throw providerStatusError("PROVIDER_RESPONSE_STATUS_UNSUPPORTED", status, response);
  }
}

// Creates a typed error for a specific provider status with optional detail.
function providerStatusError(code, status, response, detail) {
  const error = new ConfigurationError(`OpenAI Responses request is not complete: ${status}.`);
  error.code = code;
  error.providerStatus = status;
  error.responseId = response?.payload?.response_id ?? response?.response_id;
  error.completedAt = response?.completed_at ?? null;
  if (detail !== undefined && detail !== null) error.providerDetail = detail;
  return error;
}

export const call = (options) => createOpenAIAdapter(options).call(options);
export * from "./codex-adapter.js";

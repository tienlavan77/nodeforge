import * as codex from "./codex-adapter.js";
import { buildCacheOptions, buildInput, buildInstructions, buildResponseFormat, buildToolConfig } from "./openai-request-builder.js";
import { createOpenAITranscriptResolver } from "./openai-transcript-resolver.js";
import { normalizeResponse } from "./openai-response-normalizer.js";
import { ConfigurationError } from "../../../shared/errors.js";

/** Public OpenAI adapter entry point for the canonical generic payload. */
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
    return normalizeResponse(raw, { request_id: genericPayload.request_id ?? genericPayload.requestId, expected_type: genericPayload.expected_output?.type ?? genericPayload.expected_submission?.type });
  }
}

export const call = (options) => createOpenAIAdapter(options).call(options);
export * from "./codex-adapter.js";

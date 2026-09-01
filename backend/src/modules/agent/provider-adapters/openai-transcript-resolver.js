import { ConfigurationError } from "../../../shared/errors.js";

export function createOpenAITranscriptResolver({ storage } = {}) {
  if (typeof storage?.get !== "function") throw new ConfigurationError("OpenAI transcript resolver requires Protocol Storage.");
  return Object.freeze({ resolveTranscript });

  async function resolveTranscript(payload = {}) {
    if (!Array.isArray(payload.transcript_blocks)) throw transcriptError("TRANSCRIPT_INVALID", "transcript_blocks must be an array.");
    if (payload.conversation_mode === "hybrid" && (!Number.isInteger(payload.hybrid_window) || payload.hybrid_window < 1)) {
      throw transcriptError("TRANSCRIPT_INVALID", "hybrid_window must be a positive integer in hybrid mode.");
    }
    const ordered = [...payload.transcript_blocks].sort((left, right) => left.round - right.round);
    return Promise.all(ordered.map(resolveBlock));
  }

  async function resolveBlock(block) {
    assertBlock(block);
    if (!block.in_window) {
      return Object.freeze({
        block_id: block.block_id,
        round: block.round,
        in_window: false,
        cacheable: block.cacheable,
        text: oneLine(block.response_summary)
      });
    }
    try {
      const [request, response] = await Promise.all([
        storage.get(block.full_request_ref),
        storage.get(block.full_response_ref)
      ]);
      return Object.freeze({
        block_id: block.block_id,
        round: block.round,
        in_window: true,
        cacheable: block.cacheable,
        instruction: block.instruction,
        full_request_ref: block.full_request_ref,
        full_response_ref: block.full_response_ref,
        full_request: request.data,
        full_response: response.data
      });
    } catch (error) {
      const failure = transcriptError("TRANSCRIPT_RESOLVE_FAILED", `Unable to resolve transcript round ${block.round}: ${error.message}`);
      failure.cause = error;
      throw failure;
    }
  }
}

function assertBlock(block) {
  if (!block || typeof block !== "object" || !Number.isInteger(block.round) || block.round < 1 || typeof block.block_id !== "string" || !block.block_id) {
    throw transcriptError("TRANSCRIPT_INVALID", "Transcript block requires block_id and positive round.");
  }
  if (typeof block.in_window !== "boolean" || typeof block.cacheable !== "boolean" || typeof block.response_summary !== "string") {
    throw transcriptError("TRANSCRIPT_INVALID", `Transcript block ${block.block_id} has invalid flags or summary.`);
  }
  if (block.in_window && (typeof block.full_request_ref !== "string" || !block.full_request_ref || typeof block.full_response_ref !== "string" || !block.full_response_ref)) {
    throw transcriptError("TRANSCRIPT_INVALID", `Transcript block ${block.block_id} requires storage refs.`);
  }
}

function oneLine(value) { return value.replace(/\s+/g, " ").trim(); }
function transcriptError(code, message) { const error = new ConfigurationError(message); error.code = code; return error; }

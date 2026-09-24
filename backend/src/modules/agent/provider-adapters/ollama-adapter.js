// Calls Ollama Cloud through its OpenAI-compatible chat-completions endpoint.
// Profiles store only the bare host (e.g. https://ollama.com); this adapter
// appends /v1/chat/completions before delegating to the shared custom adapter.
import { ConfigurationError } from "../../../shared/errors.js";
import * as custom from "./custom-adapter.js";

const SAFE_URL = /^https:\/\//;
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

// Sends a request to the normalized chat-completions endpoint.
export async function request({ url, credential, payload, model, correlationId, signal }) {
  return custom.request({ url: normalizeEndpoint(url), credential, payload, model, correlationId, signal });
}

// Streams from the normalized chat-completions endpoint.
export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  yield* custom.stream({ url: normalizeEndpoint(url), credential, payload, model, correlationId, signal });
}

// Normalizes a bare Ollama host to the full chat-completions endpoint.
export function normalizeEndpoint(value) {
  if (typeof value !== "string" || !SAFE_URL.test(value)) throw new ConfigurationError("Ollama gateway URL must use HTTPS.");
  const host = value.replace(/\/+$/, "").replace(/\/v1\/chat\/completions$/, "").replace(/\/chat\/completions$/, "").replace(/\/v1$/, "");
  return `${host}${CHAT_COMPLETIONS_PATH}`;
}

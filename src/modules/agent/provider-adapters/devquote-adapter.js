/**
 * Devquote Gateway Adapter
 *
 * Uses Anthropic Messages API format (Claude Desktop compatible) with bearer auth.
 * Gateway: https://sv.devquote.shop
 * Models: claude-haiku-4-5, claude-sonnet-4-6, claude-opus-4-7, claude-opus-5, claude-opus-4-8[1m], etc.
 *
 * Auth scheme: Authorization: Bearer <api_key>
 * API format: Anthropic Messages API (https://docs.anthropic.com/en/api/messages)
 * Endpoint:   https://sv.devquote.shop/v1/messages
 */

import { ConfigurationError } from "../../../shared/errors.js";

/**
 * Normalize URL to ensure /v1/messages endpoint
 */
function normalizeUrl(url) {
  const normalized = url.replace(/\/$/, "");
  if (normalized.endsWith("/v1/messages")) return normalized;
  if (normalized.endsWith("/v1")) return `${normalized}/messages`;
  return `${normalized}/v1/messages`;
}

export async function request({ url, credential, payload, model, correlationId, signal }) {
  const endpoint = normalizeUrl(url);
  const requestBody = {
    model: model || process.env.DEVQUOTE_MODEL || process.env.NODE_AGENT_MODEL || "claude-haiku-4-5",
    max_tokens: 8192,
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }],
    tools: toAnthropicTools(payload.tools),
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${credential}`,
      "x-correlation-id": correlationId,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 1000);
    throw new ConfigurationError(`Devquote Gateway returned HTTP ${response.status}: ${errorText || "<empty body>"}`);
  }

  const data = await response.json();
  const text = extractText(data);
  if (!text) throw new ConfigurationError("Devquote Gateway response is invalid.");

  return {
    status: data.status ?? "completed",
    payload: {
      text,
      response_id: data.id ?? data.message?.id ?? data.response_id
    }
  };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  const endpoint = normalizeUrl(url);
  const requestBody = {
    model: model || process.env.DEVQUOTE_MODEL || process.env.NODE_AGENT_MODEL || "claude-haiku-4-5",
    max_tokens: 8192,
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }],
    tools: toAnthropicTools(payload.tools),
    stream: true
  };

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${credential}`,
      "x-correlation-id": correlationId,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(requestBody),
    signal
  });

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 1000);
    throw new ConfigurationError(`Devquote Gateway stream returned HTTP ${response.status}: ${errorText || "<empty body>"}`);
  }
  if (!response.body) throw new ConfigurationError("Devquote Gateway stream returned no body.");

  const decoder = new TextDecoder();
  let buffer = "";
  let toolUse;
  let toolInput = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();

    for (const frame of frames) {
      const lines = frame.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!dataLine || dataLine === "[DONE]") continue;

      let event;
      try {
        event = JSON.parse(dataLine);
      } catch {
        throw new ConfigurationError("Devquote Gateway stream is invalid.");
      }

      // Anthropic Messages API stream events
      if (event.type === "content_block_delta" && typeof event.delta?.text === "string") {
        yield { text: event.delta.text };
      } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        toolUse = { id: event.content_block.id, name: event.content_block.name };
        toolInput = "";
      } else if (event.type === "content_block_delta" && typeof event.delta?.partial_json === "string") {
        toolInput += event.delta.partial_json;
      } else if (event.type === "content_block_stop" && toolUse) {
        let input = {};
        try { input = toolInput ? JSON.parse(toolInput) : {}; } catch { throw new ConfigurationError("Devquote tool input is invalid."); }
        yield { tool_use: { ...toolUse, input } };
        toolUse = undefined;
      } else if (event.type === "content_block_start" && event.content_block?.type === "text") {
        // Start of text block (optional, for tracking)
      } else if (event.type === "message_stop") {
        const rid = event.message?.id ?? event.id;
        if (rid) yield { response_id: rid };
        else yield { response_id: "devquote-stream-complete" };
      } else if (event.type === "error") {
        throw new ConfigurationError("Devquote Gateway stream failed.");
      }
    }
  }
}

function extractText(data) {
  // Anthropic Messages API response format
  if (Array.isArray(data?.content)) {
    const text = data.content
      .filter((c) => typeof c?.text === "string")
      .map((c) => c.text)
      .join("\n");
    if (text) return text;
  }

  // Fallback: direct text field
  if (typeof data?.text === "string" && data.text) return data.text;

  // Fallback: output_text (older format)
  if (typeof data?.output_text === "string") return data.output_text;

  // Fallback: choices (OpenAI-compatible fallback)
  if (Array.isArray(data?.choices) && typeof data.choices[0]?.message?.content === "string") {
    return data.choices[0].message.content;
  }

  return "";
}

function toAnthropicTools(tools = []) {
  return tools?.length ? tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.input_schema })) : undefined;
}

import { ConfigurationError } from "../../../shared/errors.js";
import * as codex from "./codex-adapter.js";

export async function request({ url, credential, payload, model, correlationId, signal }) {
  const isResponses = url.replace(/\/$/, "").endsWith("/responses");
  if (isResponses) return codex.request({ url, credential, payload, model, correlationId, signal });
  const body = {
    model: model || process.env.NODE_AGENT_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }]
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) throw new ConfigurationError("Agent Gateway response is invalid.");
  const data = await response.json();
  if (data?.output || typeof data?.output_text === "string") {
    const isResp = url.includes("/responses") || data.output;
    if (isResp) {
      try { return await codex.request({ url, credential, payload, model, correlationId, signal }); } catch (_ignored) { void _ignored; }
    }
  }
  const text = data?.choices?.[0]?.message?.content ?? data?.content?.find?.((c) => typeof c?.text === "string")?.text ?? data?.text ?? data?.output_text;
  if (!text || typeof text !== "string") throw new ConfigurationError("Agent Gateway response is invalid.");
  return { status: data.status ?? "completed", payload: { text, response_id: data.id ?? data.response_id } };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  const isResponses = url.replace(/\/$/, "").endsWith("/responses");
  if (isResponses) {
    for await (const chunk of codex.stream({ url, credential, payload, model, correlationId, signal })) yield chunk;
    return;
  }
  const body = {
    model: model || process.env.NODE_AGENT_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }],
    stream: true
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok || !response.body) throw new ConfigurationError("Agent Gateway response is invalid.");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop();
    for (const frame of frames) {
      const data = frame.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { throw new ConfigurationError("Agent Gateway stream is invalid."); }
      if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
      const delta = event.choices?.[0]?.delta?.content ?? event.delta?.text ?? event.text;
      if (typeof delta === "string" && delta) yield { text: delta };
      if (event.type === "content_block_delta" && typeof event.delta?.text === "string") yield { text: event.delta.text };
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") yield { text: event.delta };
      if (event.choices?.[0]?.finish_reason) {
        const rid = event.id ?? event.response?.id;
        if (rid) yield { response_id: rid };
      }
      if (event.type === "response.completed" || event.type === "message_stop") {
        const rid = event.response?.id ?? event.id ?? event.message?.id;
        if (rid) yield { response_id: rid };
      }
    }
  }
}

import { ConfigurationError } from "../../../shared/errors.js";

export async function request({ url, credential, payload, model, correlationId, signal }) {
  const isResponses = url.replace(/\/$/, "").endsWith("/responses");
  const requestBody = isResponses
    ? { model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload) }
    : payload;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify(requestBody),
    signal
  });
  if (!response.ok) throw new ConfigurationError("Agent Gateway response is invalid.");
  const body = await response.json();
  if (isResponses) return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id } };
  return { status: "completed", payload: body };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  if (!url.replace(/\/$/, "").endsWith("/responses")) throw new ConfigurationError("Agent Gateway streaming requires a Responses API endpoint.");
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload), stream: true }),
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
      const data = frame.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let event;
      try { event = JSON.parse(data); } catch { throw new ConfigurationError("Agent Gateway stream is invalid."); }
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") yield { text: event.delta };
      if (event.type === "response.completed") yield { response_id: event.response?.id ?? event.response?.response_id };
      if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
    }
  }
}

function extractResponseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const parts = body?.output?.flatMap((item) => item.content ?? []) ?? [];
  const text = parts.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n");
  if (!text) throw new ConfigurationError("Agent Gateway response is invalid.");
  return text;
}

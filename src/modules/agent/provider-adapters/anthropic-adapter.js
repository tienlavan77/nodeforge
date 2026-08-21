import { ConfigurationError } from "../../../shared/errors.js";

export async function request({ url, credential, payload, model, correlationId, signal }) {
  const body = {
    model: model || process.env.CLAUDE_MODEL || process.env.NODE_AGENT_MODEL || "claude-sonnet-4-5-20251001",
    max_tokens: 8192,
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }]
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": credential, "anthropic-version": "2023-06-01", "x-correlation-id": correlationId },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) throw new ConfigurationError("Agent Gateway response is invalid.");
  const data = await response.json();
  const text = data?.content?.find((c) => typeof c?.text === "string")?.text ?? data?.output_text ?? extractText(data);
  if (!text) throw new ConfigurationError("Agent Gateway response is invalid.");
  return { status: data.status ?? "completed", payload: { text, response_id: data.id ?? data.response_id } };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  const body = {
    model: model || process.env.CLAUDE_MODEL || process.env.NODE_AGENT_MODEL || "claude-sonnet-4-5-20251001",
    max_tokens: 8192,
    messages: [{ role: "user", content: payload.text ?? JSON.stringify(payload) }],
    stream: true
  };
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": credential, "anthropic-version": "2023-06-01", "x-correlation-id": correlationId },
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
      const lines = frame.split("\n");
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(5).trim();
      if (!dataLine || dataLine === "[DONE]") continue;
      let event;
      try { event = JSON.parse(dataLine); } catch { throw new ConfigurationError("Agent Gateway stream is invalid."); }
      if (event.type === "content_block_delta" && typeof event.delta?.text === "string") yield { text: event.delta.text };
      else if (event.type === "response.output_text.delta" && typeof event.delta === "string") yield { text: event.delta };
      else if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
      if (event.type === "message_stop" || event.type === "response.completed") {
        const rid = event.message?.id ?? event.response?.id ?? event.id;
        if (rid) yield { response_id: rid };
        else yield { response_id: "anthropic-stream-complete" };
      }
    }
  }
}

function extractText(data) {
  if (typeof data?.content === "string") return data.content;
  if (Array.isArray(data?.content)) {
    const t = data.content.filter((c) => typeof c?.text === "string").map((c) => c.text).join("\n");
    if (t) return t;
  }
  if (Array.isArray(data?.choices) && typeof data.choices[0]?.message?.content === "string") return data.choices[0].message.content;
  if (Array.isArray(data?.output)) {
    const outputText = data.output.flatMap((item) => item?.content ?? []).filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n");
    if (outputText) return outputText;
  }
  if (typeof data?.text === "string") return data.text;
  return "";
}

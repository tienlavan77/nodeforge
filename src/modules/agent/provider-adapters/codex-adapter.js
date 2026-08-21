import { ConfigurationError } from "../../../shared/errors.js";

export async function request({ url, credential, payload, model, correlationId, signal }) {
  url = responsesUrl(url);
  const isResponses = true;
  const requestBody = isResponses
    ? { model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload) }
    : payload;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify(requestBody),
    signal
  });
  if (!response.ok) throw await gatewayError(response, "Codex Responses");
  const body = await response.json();
  if (isResponses) return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id, tool_use: extractToolUse(body) } };
  return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id ?? body.response_id } };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  url = responsesUrl(url);
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload), stream: true }),
    signal
  });
  if (!response.ok) throw await gatewayError(response, "Codex Responses stream");
  if (!response.body) throw new ConfigurationError("Codex Responses stream returned no body.");
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
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") yield { _tool: { id: event.item.call_id ?? event.item.id, name: event.item.name }, _toolInput: "" };
      if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") yield { _toolInputDelta: event.delta };
      if (event.type === "response.function_call_arguments.done") {
        let input = {};
        try { input = JSON.parse(event.arguments ?? "{}"); } catch { throw new ConfigurationError("Codex tool input is invalid."); }
        yield { tool_use: { id: event.call_id ?? event.item_id, name: event.name ?? "terminal.run", input } };
      }
      if (event.type === "response.completed") yield { response_id: event.response?.id ?? event.response?.response_id };
      if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
    }
  }
}

function responsesUrl(value) {
  const normalized = value.replace(/\/+$/, "").replace(/\/response$/, "/responses");
  if (/\/v1$/.test(normalized)) return `${normalized}/responses`;
  if (/^https?:\/\/[^/]+$/.test(normalized)) return `${normalized}/v1/responses`;
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function extractResponseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const parts = body?.output?.flatMap((item) => item.content ?? []) ?? [];
  const text = parts.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n");
  if (text) return text;
  const choiceText = body?.choices?.[0]?.message?.content ?? body?.choices?.[0]?.text;
  if (typeof choiceText === "string" && choiceText) return choiceText;
  if (typeof body?.content === "string" && body.content) return body.content;
  if (Array.isArray(body?.content)) {
    const contentText = body.content.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n");
    if (contentText) return contentText;
  }
  throw new ConfigurationError("Agent Gateway response is invalid.");
}

function extractToolUse(body) {
  const item = body?.output?.find((entry) => entry.type === "function_call");
  if (!item) return undefined;
  let input = {};
  try { input = JSON.parse(item.arguments ?? "{}"); } catch { throw new ConfigurationError("Codex tool input is invalid."); }
  return { id: item.call_id ?? item.id, name: item.name, input };
}

async function gatewayError(response, label) {
  let body = "";
  try { body = (await response.text()).slice(0, 1000); } catch { body = "<unreadable body>"; }
  return new ConfigurationError(`${label} gateway returned HTTP ${response.status}: ${body || "<empty body>"}`);
}

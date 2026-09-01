import { ConfigurationError } from "../../../shared/errors.js";
import { buildCacheOptions, buildResponsesInput, buildToolConfig, mapOpenAIUsage } from "./openai-request-builder.js";

export async function request({ url, credential, payload, preparedRequest, model, correlationId, signal }) {
  url = responsesUrl(url);
  const isResponses = true;
  const requestBody = isResponses
    ? (preparedRequest ?? { model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: buildResponsesInput(payload), ...buildCacheOptions(payload) })
    : payload;
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ ...requestBody, ...responseToolOptions(payload, requestBody) }),
    signal
  }, "Codex Responses");
  if (!response.ok) throw await gatewayError(response, "Codex Responses");
  const body = await response.json();
  if (isResponses) return { status: body.status ?? "completed", payload: { text: extractResponseText(body, { allowEmpty: true }), response_id: body.id, tool_use: extractToolUse(body), usage: mapOpenAIUsage(body.usage) } };
  return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id ?? body.response_id } };
}

export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  url = responsesUrl(url);
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: buildResponsesInput(payload), ...buildCacheOptions(payload), ...responseToolOptions(payload), stream: true }),
    signal
  }, "Codex Responses stream");
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
      if (event.type === "response.completed") yield { response_id: event.response?.id ?? event.response?.response_id, usage: mapOpenAIUsage(event.response?.usage ?? event.usage) };
      if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
    }
  }
}

function responseToolOptions(payload, requestBody = {}) {
  if (requestBody.tools) return { tools: requestBody.tools, ...(requestBody.tool_choice ? { tool_choice: requestBody.tool_choice } : {}) };
  if (!Array.isArray(payload?.tools) || payload.tools.length === 0) return {};
  const config = buildToolConfig(payload);
  return {
    tools: config.tools.map((tool) => ({ ...tool, parameters: tool.parameters ?? tool.input_schema })),
    tool_choice: config.tool_choice
  };
}

function responsesUrl(value) {
  const normalized = value.replace(/\/+$/, "").replace(/\/response$/, "/responses");
  if (/\/v1$/.test(normalized)) return `${normalized}/responses`;
  if (/^https?:\/\/[^/]+$/.test(normalized)) return `${normalized}/v1/responses`;
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

function extractResponseText(body, { allowEmpty = false } = {}) {
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
  if (allowEmpty) return undefined;
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
  const error = new ConfigurationError(`${label} gateway returned HTTP ${response.status}: ${body || "<empty body>"}`);
  error.statusCode = response.status;
  error.code = response.status === 429 ? "RATE_LIMITED" : `UPSTREAM_${response.status}`;
  return error;
}

async function fetchWithRetry(url, options, label, { maxRetries = 2, baseDelayMs = 100 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, options);
    if (response.ok || response.status !== 429 || attempt >= maxRetries) return response;
    try { await response.body?.cancel(); } catch { /* response already closed */ }
    await delay(baseDelayMs * (2 ** attempt), options.signal);
  }
}

function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })); }, { once: true });
  });
}

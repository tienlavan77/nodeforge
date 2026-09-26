// Implements the OpenAI Responses API gateway for Codex including polling and streaming.
import { ConfigurationError } from "../../../shared/errors.js";
import { buildCacheOptions, buildResponsesInput, buildToolConfig, mapOpenAIUsage } from "./openai-request-builder.js";

// Sends a Responses API request with retry and polls until a terminal status.
export async function request({ url, credential, payload, preparedRequest, model, correlationId, signal }) {
  url = responsesUrl(url);
  const isResponses = true;
  const requestBody = isResponses
    ? (preparedRequest ?? { model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: buildResponsesInput(payload), ...buildCacheOptions(payload) })
    : payload;
  let response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ ...requestBody, ...responseToolOptions(payload, requestBody) }),
    signal
  }, "Codex Responses");
  if (!response.ok) throw await gatewayError(response, "Codex Responses");
  let body = await response.json();
  if (isResponses) {
    ({ response, body } = await pollUntilTerminal({ url, credential, correlationId, signal, response, body }));
    return {
      status: body.status ?? "completed",
      completed_at: body.completed_at ?? null,
      error: body.error ?? null,
      incomplete_details: body.incomplete_details ?? null,
      // Preserve the provider response for persistence when normalization fails.
      raw_response: body,
      payload: { text: extractResponseText(body, { allowEmpty: true }), response_id: body.id, tool_use: extractToolUse(body), usage: mapOpenAIUsage(body.usage) }
    };
  }
  return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id ?? body.response_id } };
}

// Streams Responses deltas and assembles incremental tool-call arguments.
export async function* stream({ url, credential, payload, model, correlationId, signal }) {
  url = responsesUrl(url);
  const response = await fetchWithRetry(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId },
    body: JSON.stringify({ model: model || process.env.NODE_AGENT_MODEL || "gpt-5.6-terra", input: buildResponsesInput(payload), ...buildCacheOptions(payload), ...responseToolOptions(payload), ...(Number.isInteger(payload.max_output_tokens) && payload.max_output_tokens > 0 ? { max_output_tokens: payload.max_output_tokens } : {}), stream: true }),
    signal
  }, "Codex Responses stream");
  if (!response.ok) throw await gatewayError(response, "Codex Responses stream");
  if (!response.body) throw new ConfigurationError("Codex Responses stream returned no body.");
  const decoder = new TextDecoder();
  let buffer = "";
  const pendingTools = new Map();
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
      if (event.type === "response.output_item.added" && event.item?.type === "function_call") pendingTools.set(event.item.id ?? event.item.call_id, { id: event.item.call_id ?? event.item.id, name: event.item.name, arguments: "" });
      if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const pending = pendingTools.get(event.call_id ?? event.item_id);
        if (pending) pending.arguments += event.delta;
      }
      if (event.type === "response.function_call_arguments.done") {
        const itemId = event.item_id ?? event.call_id;
        const pending = pendingTools.get(itemId);
        let input = {};
        try { input = JSON.parse(event.arguments ?? pending?.arguments ?? "{}"); } catch { throw new ConfigurationError("Codex tool input is invalid."); }
        pendingTools.delete(itemId);
        yield { tool_use: { id: event.call_id ?? pending?.id ?? itemId, name: event.name ?? pending?.name ?? "terminal.run", input } };
      }
      if (event.type === "response.completed") yield { response_id: event.response?.id ?? event.response?.response_id, usage: mapOpenAIUsage(event.response?.usage ?? event.usage) };
      if (event.type === "error") throw new ConfigurationError("Agent Gateway stream failed.");
    }
  }
}

// Builds tool and tool_choice options for Responses or payload-supplied tools.
function responseToolOptions(payload, requestBody = {}) {
  if (requestBody.tools) return { tools: requestBody.tools, ...(requestBody.tool_choice ? { tool_choice: requestBody.tool_choice } : {}) };
  if (!Array.isArray(payload?.tools) || payload.tools.length === 0) return {};
  const config = buildToolConfig(payload);
  return {
    tools: config.tools.map((tool) => ({ ...tool, parameters: tool.parameters ?? tool.input_schema })),
    tool_choice: config.tool_choice
  };
}

// Normalizes a gateway URL to the /responses endpoint form.
function responsesUrl(value) {
  const normalized = value.replace(/\/+$/, "").replace(/\/response$/, "/responses");
  if (/\/v1$/.test(normalized)) return `${normalized}/responses`;
  if (/^https?:\/\/[^/]+$/.test(normalized)) return `${normalized}/v1/responses`;
  return normalized.endsWith("/responses") ? normalized : `${normalized}/responses`;
}

// Extracts text from Responses bodies across output, choices, and content variants.
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

// Extracts the first function_call item from a Responses body as normalized tool use.
function extractToolUse(body) {
  const item = body?.output?.find((entry) => entry.type === "function_call");
  if (!item) return undefined;
  let input = {};
  try { input = JSON.parse(item.arguments ?? "{}"); } catch { throw new ConfigurationError("Codex tool input is invalid."); }
  return { id: item.call_id ?? item.id, name: item.name, input };
}

async function pollUntilTerminal({ url, credential, correlationId, signal, response, body }) {
  const pending = new Set(["queued", "in_progress"]);
  if (!pending.has(body?.status) || !body?.id) return { response, body };
  const maxDurationMs = Math.max(1000, Number.parseInt(process.env.NODE_AGENT_POLL_TIMEOUT_MS ?? "120000", 10));
  const intervalMs = Math.max(1000, Number.parseInt(process.env.NODE_AGENT_POLL_INTERVAL_MS ?? "5000", 10));
  const pollUrl = `${url.replace(/\/$/, "")}/${encodeURIComponent(body.id)}`;
  const deadline = Date.now() + maxDurationMs;
  while (pending.has(body.status) && Date.now() < deadline) {
    await delay(Math.min(intervalMs, Math.max(0, deadline - Date.now())), signal);
    const polled = await fetchWithRetry(pollUrl, { method: "GET", headers: { authorization: `Bearer ${credential}`, "x-correlation-id": correlationId }, signal }, "Codex Responses polling");
    if (!polled.ok) throw await gatewayError(polled, "Codex Responses polling");
    response = polled;
    body = await polled.json();
  }
  if (pending.has(body?.status)) {
    const error = new ConfigurationError(`OpenAI Responses polling timed out: ${body.status}.`);
    error.code = "PROVIDER_RESPONSE_POLL_TIMEOUT";
    error.providerStatus = body.status;
    error.responseId = body.id;
    throw error;
  }
  return { response, body };
}

async function gatewayError(response, label) {
  let body = "";
  // eslint-disable-next-line no-silent-catch -- Error body placeholder; status code is preserved in the thrown error.
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
    // eslint-disable-next-line no-silent-catch -- Response already closed during 429 backoff.
    try { await response.body?.cancel(); } catch { /* response already closed */ }
    await delay(baseDelayMs * (2 ** attempt), options.signal);
  }
}

// Waits for a duration or until an abort signal fires.
function delay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" })); }, { once: true });
  });
}

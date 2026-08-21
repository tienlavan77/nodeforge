import { ConfigurationError } from "../../shared/errors.js";
import { getAdapter } from "./provider-adapters/index.js";

const SAFE_URL = /^https:\/\//;

export function createAgentGateway({ configuration, credentialResolver, transport = defaultTransport, streamTransport = defaultStreamTransport, timeoutMs = 10000, adapterRegistry = getAdapter } = {}) {
  if (typeof configuration?.getById !== "function") throw new ConfigurationError("Agent Gateway requires Node Agent Configuration.");
  if (typeof credentialResolver !== "function") throw new ConfigurationError("Agent Gateway requires a credential resolver.");
  if (typeof transport !== "function" || typeof streamTransport !== "function") throw new ConfigurationError("Agent Gateway transport must be a function.");
  if (typeof adapterRegistry !== "function") throw new ConfigurationError("Agent Gateway adapter registry must be a function.");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new ConfigurationError("Agent Gateway timeout must be a positive integer.");

  const isDefaultTransport = transport === defaultTransport;
  const isDefaultStreamTransport = streamTransport === defaultStreamTransport;

  return Object.freeze({ request, stream, testConnection });

  async function request({ agentId, payload, correlationId } = {}) {
    const config = getEnabledConfig(agentId);
    assertCorrelation(correlationId);
    if (!payload || typeof payload !== "object") throw new ConfigurationError("Agent Gateway payload is required.");
    const credential = await resolveCredential(config.credential_ref);
    if (!isDefaultTransport) {
      return callTransport({ config, credential, payload: structuredClone(payload), correlationId, operation: "request" });
    }
    const adapter = adapterRegistry(config.provider);
    const model = config.model || undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await adapter.request({ url: config.gateway_url, credential, payload: structuredClone(payload), model, correlationId, signal: controller.signal });
      validateResponse(response);
      return { agent_id: config.agent_id, correlation_id: correlationId, status: response.status ?? "completed", payload: structuredClone(response.payload ?? response.data ?? response) };
    } catch (error) {
      if (error?.name === "AbortError") throw new ConfigurationError(`Agent Gateway request timed out for ${config.agent_id}.`);
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`Agent Gateway request failed for ${config.agent_id}.`);
    } finally { clearTimeout(timeout); }
  }

  async function* stream({ agentId, payload, correlationId } = {}) {
    const config = getEnabledConfig(agentId);
    assertCorrelation(correlationId);
    if (!payload || typeof payload !== "object") throw new ConfigurationError("Agent Gateway payload is required.");
    const credential = await resolveCredential(config.credential_ref);
    if (!isDefaultStreamTransport) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        for await (const event of streamTransport({ url: config.gateway_url, credential, payload: structuredClone(payload), correlation_id: correlationId, signal: controller.signal })) {
          if (typeof event?.text === "string" && event.text) yield { agent_id: config.agent_id, correlation_id: correlationId, text: event.text };
          if (event?.tool_use) yield { agent_id: config.agent_id, correlation_id: correlationId, tool_use: event.tool_use };
          if (event?.response_id) yield { agent_id: config.agent_id, correlation_id: correlationId, completed: true, response_id: event.response_id };
        }
      } catch (error) {
        if (error?.name === "AbortError") throw new ConfigurationError(`Agent Gateway request timed out for ${config.agent_id}.`);
        if (error instanceof ConfigurationError) throw error;
        throw new ConfigurationError(`Agent Gateway request failed for ${config.agent_id}.`);
      } finally { clearTimeout(timeout); }
      return;
    }
    const adapter = adapterRegistry(config.provider);
    const model = config.model || undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      for await (const event of adapter.stream({ url: config.gateway_url, credential, payload: structuredClone(payload), model, correlationId, signal: controller.signal })) {
        if (typeof event?.text === "string" && event.text) yield { agent_id: config.agent_id, correlation_id: correlationId, text: event.text };
        if (event?.tool_use) yield { agent_id: config.agent_id, correlation_id: correlationId, tool_use: event.tool_use };
        if (event?.response_id) yield { agent_id: config.agent_id, correlation_id: correlationId, completed: true, response_id: event.response_id };
      }
    } catch (error) {
      if (error?.name === "AbortError") throw new ConfigurationError(`Agent Gateway request timed out for ${config.agent_id}.`);
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`Agent Gateway request failed for ${config.agent_id}.`);
    } finally { clearTimeout(timeout); }
  }

  async function testConnection(agentId) {
    const config = getEnabledConfig(agentId);
    const credential = await resolveCredential(config.credential_ref);
    if (!isDefaultTransport) {
      await callTransport({ config, credential, payload: { text: "Health check. Respond with OK." }, correlationId: `CONNECTION-${agentId}`, operation: "health" });
      return { agent_id: agentId, status: "CONNECTED", gateway_url: config.gateway_url };
    }
    const adapter = adapterRegistry(config.provider);
    const model = config.model || undefined;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await adapter.request({ url: config.gateway_url, credential, payload: { text: "Health check. Respond with OK." }, model, correlationId: `CONNECTION-${agentId}`, signal: controller.signal });
      validateResponse(response);
    } catch (error) {
      if (error?.name === "AbortError") throw new ConfigurationError(`Agent Gateway request timed out for ${config.agent_id}.`);
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`Agent Gateway request failed for ${config.agent_id}.`);
    } finally { clearTimeout(timeout); }
    return { agent_id: agentId, status: "CONNECTED", gateway_url: config.gateway_url };
  }

  function getEnabledConfig(agentId) {
    if (typeof agentId !== "string" || agentId.length === 0) throw new ConfigurationError("Agent Gateway agent_id is required.");
    const config = configuration.getById(agentId);
    if (!config) throw new ConfigurationError(`Unknown Agent Gateway profile: ${agentId}.`);
    if (!config.enabled) throw new ConfigurationError(`Agent Gateway is disabled: ${agentId}.`);
    if (!SAFE_URL.test(config.gateway_url)) throw new ConfigurationError(`Agent Gateway URL is invalid for ${agentId}.`);
    return { ...config, gateway_url: normalizeGatewayUrl(config.gateway_url) };
  }

  async function resolveCredential(reference) {
    const value = await credentialResolver(reference);
    if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("Agent Gateway credential is unavailable.");
    return value;
  }

  async function callTransport({ config, credential, payload, correlationId, operation }) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await transport({ url: config.gateway_url, credential, payload, correlation_id: correlationId, operation, signal: controller.signal });
      validateResponse(response);
      return { agent_id: config.agent_id, correlation_id: correlationId, status: response.status ?? "completed", payload: structuredClone(response.payload ?? response.data ?? response) };
    } catch (error) {
      if (error?.name === "AbortError") throw new ConfigurationError(`Agent Gateway request timed out for ${config.agent_id}.`);
      if (error instanceof ConfigurationError) throw error;
      throw new ConfigurationError(`Agent Gateway request failed for ${config.agent_id}.`);
    } finally { clearTimeout(timeout); }
  }
}

function normalizeGatewayUrl(value) {
  const normalized = value.replace(/\/+$/, "");
  return normalized.endsWith("/response") ? `${normalized}s` : normalized;
}

function validateResponse(response) {
  if (!response || typeof response !== "object" || response.ok === false || (response.statusCode !== undefined && response.statusCode >= 400)) throw new ConfigurationError("Agent Gateway response is invalid.");
}

function assertCorrelation(value) {
  if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("Agent Gateway correlation_id is required.");
}

async function defaultTransport({ url, credential, payload, correlation_id: correlationId, signal }) {
  const isResponses = url.replace(/\/$/, "").endsWith("/responses");
  const requestBody = isResponses
    ? { model: process.env.NODE_AGENT_MODEL ?? "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload) }
    : payload;
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId }, body: JSON.stringify(requestBody), signal });
  if (!response.ok) throw new ConfigurationError("Agent Gateway response is invalid.");
  const body = await response.json();
  if (isResponses) return { status: body.status ?? "completed", payload: { text: extractResponseText(body), response_id: body.id } };
  return { status: "completed", payload: body };
}

function extractResponseText(body) {
  if (typeof body?.output_text === "string") return body.output_text;
  const parts = body?.output?.flatMap((item) => item.content ?? []) ?? [];
  const text = parts.filter((item) => typeof item?.text === "string").map((item) => item.text).join("\n");
  if (!text) throw new ConfigurationError("Agent Gateway response is invalid.");
  return text;
}

async function* defaultStreamTransport({ url, credential, payload, correlation_id: correlationId, signal }) {
  if (!url.replace(/\/$/, "").endsWith("/responses")) throw new ConfigurationError("Agent Gateway streaming requires a Responses API endpoint.");
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}`, "x-correlation-id": correlationId }, body: JSON.stringify({ model: process.env.NODE_AGENT_MODEL ?? "gpt-5.6-terra", input: payload.text ?? JSON.stringify(payload), stream: true }), signal });
  if (!response.ok || !response.body) throw new ConfigurationError("Agent Gateway response is invalid.");
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const frames = buffer.split("\n\n"); buffer = frames.pop();
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

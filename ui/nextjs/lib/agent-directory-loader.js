// Loads agent profiles with bounded retries and prevents superseded requests from leaving the directory stuck loading.
import { requestJson } from "./node-client-request.js";

// Normalizes supported agent-list envelopes without accepting an invalid response as an empty directory.
export function normalizeAgentDirectory(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.agents)) return payload.agents;
  if (Array.isArray(payload?.items)) return payload.items;
  throw new Error("Agents API returned an invalid directory. Retry after checking the Control API.");
}

// Preserves newer live agent status when an API response predates the project stream event.
export function mergeAgentProfiles(current, incoming) {
  return incoming.map((agent) => {
    const existing = current.find((item) => (item.agent_id ?? item.id) === (agent.agent_id ?? agent.id));
    return existing && String(existing.updated_at ?? "") > String(agent.updated_at ?? "") ? { ...agent, status: existing.status, updated_at: existing.updated_at } : agent;
  });
}

// Reconciles initial load, reconnect and Retry using one cancellable request rather than independent fetches.
export function createAgentDirectoryLoader({ url, onProfiles, onState, timeoutMs = 15000 }) {
  let generation = 0;
  let controller;
  let loaded = false;
  return { load, cancel };

  // Cancels outstanding reads when the page unmounts or a newer refresh takes ownership.
  function cancel() { generation += 1; controller?.abort(); }

  // Settles every live request into ready or actionable error, including stalled response bodies.
  async function load() {
    cancel();
    const request = generation;
    const pending = new AbortController();
    controller = pending;
    if (!loaded) onState("loading", "");
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; pending.abort(); }, timeoutMs);
    try {
      const payload = await requestJson(url, { cache: "no-store", signal: pending.signal, fallbackError: "Agents could not be loaded. Check the Control API and retry." });
      if (request !== generation) return;
      const profiles = normalizeAgentDirectory(payload);
      onProfiles(profiles);
      loaded = true;
      onState("ready", "");
    } catch (error) {
      if (request !== generation) return;
      onState("error", timedOut ? "Agents API timed out. Check the Control API connection and retry." : error.message);
    } finally {
      clearTimeout(timer);
      if (request === generation) controller = null;
    }
  }
}

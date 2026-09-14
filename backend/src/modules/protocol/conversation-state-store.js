import { ConfigurationError } from "../../shared/errors.js";

const TERMINAL = new Set(["completed", "failed", "needs_human_review"]);

/** Tracks workflow conversation state independently from provider payloads. */
export function createConversationStateStore({ fileService, root = ".forge/runtime/protocol-storage/conversations" } = {}) {
  if (typeof fileService?.readFile !== "function" || typeof fileService?.atomicWrite !== "function") throw new ConfigurationError("Conversation state store requires File Service readFile and atomicWrite.");
  const states = new Map();
  return Object.freeze({ create, get, list, listByAgent, update, advanceRound, markStatus, clear });

  async function list({ agentId } = {}) {
    if (agentId !== undefined) requireId(agentId, "agentId");
    const conversations = [...states.values()]
      .filter((state) => agentId === undefined || state.agent_id === agentId)
      .map((state) => structuredClone(state));
    return conversations;
  }

  async function listByAgent(agentId) { return list({ agentId }); }

  async function create({ conversationId, taskId, projectId, agentId = "builder", promptCacheKey = null } = {}) {
    requireId(conversationId, "conversationId"); requireId(taskId, "taskId");
    const state = { conversation_id: conversationId, task_id: taskId, project_id: projectId ?? null, agent_id: agentId, status: "created", current_round: 0, current_step: 0, last_request_id: null, last_provider_response_id: null, last_provider_status: null, parent_request_id: null, prompt_cache_key: promptCacheKey, context_revision: null, context_checksums: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    const existing = await get(conversationId);
    if (existing) return existing;
    states.set(conversationId, state);
    try { await persist(state); } catch (error) {
      if (error?.code === "FILE_ALREADY_EXISTS") {
        const persisted = await get(conversationId);
        if (persisted) return persisted;
      }
      throw error;
    }
    return structuredClone(state);
  }

  async function get(conversationId) {
    requireId(conversationId, "conversationId");
    if (states.has(conversationId)) return structuredClone(states.get(conversationId));
    try { const loaded = JSON.parse(await fileService.readFile({ path: `${root}/${safe(conversationId)}/state.json` })); states.set(conversationId, loaded); return structuredClone(loaded); }
    catch (error) { if (error?.code === "ENOENT" || error instanceof SyntaxError) return null; throw error; }
  }

  async function clear(conversationId) {
    requireId(conversationId, "conversationId");
    states.delete(conversationId);
    await fileService.deleteFile?.({ path: `${root}/${safe(conversationId)}/state.json` }).catch((error) => { if (error?.code !== "ENOENT") throw error; });
    return true;
  }

  async function update(conversationId, changes = {}) {
    const current = await get(conversationId); if (!current) throw new ConfigurationError(`Conversation state not found: ${conversationId}.`);
    if (changes.status && TERMINAL.has(current.status) && changes.status !== current.status) throw new ConfigurationError(`Conversation ${conversationId} is already terminal.`);
    const next = { ...current, ...structuredClone(changes), conversation_id: current.conversation_id, task_id: current.task_id, updated_at: new Date().toISOString() };
    states.set(conversationId, next); await persist(next); return structuredClone(next);
  }

  async function advanceRound(conversationId, { round, step, requestId, parentId = null, providerResponseId = null, providerStatus = null, status = "round_sent" } = {}) {
    const current = await get(conversationId); if (!current) throw new ConfigurationError(`Conversation state not found: ${conversationId}.`);
    if (!Number.isInteger(round) || round < current.current_round) throw new ConfigurationError("Conversation round must advance monotonically.");
    return update(conversationId, { current_round: round, current_step: step ?? round, last_request_id: requestId ?? current.last_request_id, parent_request_id: parentId, last_provider_response_id: providerResponseId, last_provider_status: providerStatus, status });
  }

  async function markStatus(conversationId, status, details = {}) { return update(conversationId, { status, ...details }); }

  async function persist(state) { await fileService.atomicWrite({ path: `${root}/${safe(state.conversation_id)}/state.json`, content: `${JSON.stringify(state)}\n`, replace: true }); }
}

function requireId(value, name) { if (typeof value !== "string" || !value) throw new ConfigurationError(`Conversation state requires ${name}.`); }
function safe(value) { if (!/^[A-Za-z0-9._-]+$/.test(value)) throw new ConfigurationError("Conversation ID contains unsafe characters."); return value; }

import { randomUUID } from 'node:crypto';

const DEFAULT_STATE = { conversations: [] };

export function createConversationStateStore({ storage, path = 'conversation-state.json', filePath } = {}) {
  if (!storage) throw new Error('storage is required');
  const statePath = filePath || path;
  let state = normalizeState(readState(storage, statePath));

  function list() {
    return state.conversations.map(copyConversation);
  }

  function listByAgent(agentId) {
    const selectedAgentId = requireId(agentId, 'agentId');
    return state.conversations
      .filter((conversation) => conversation.agentId === selectedAgentId)
      .map(copyConversation);
  }

  function create(input = {}) {
    const agentId = requireId(input.agentId, 'agentId');
    const now = new Date().toISOString();
    const conversation = {
      id: input.id || randomUUID(),
      agentId,
      title: input.title || 'New conversation',
      status: input.status || 'active',
      round: Number.isInteger(input.round) ? input.round : 0,
      messages: Array.isArray(input.messages) ? input.messages.map(copyValue) : [],
      events: Array.isArray(input.events) ? input.events.map(copyValue) : [],
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now
    };
    state.conversations.push(conversation);
    persist();
    return copyConversation(conversation);
  }

  function get(id) {
    const conversationId = requireId(id, 'id');
    const conversation = state.conversations.find((item) => item.id === conversationId);
    return conversation ? copyConversation(conversation) : null;
  }

  function clear() {
    state = normalizeState(DEFAULT_STATE);
    persist();
  }

  function update(id, patch = {}) {
    const conversation = requireConversation(id);
    Object.assign(conversation, copyValue(patch), { id: conversation.id, updatedAt: new Date().toISOString() });
    persist();
    return copyConversation(conversation);
  }

  function advanceRound(id) {
    const conversation = requireConversation(id);
    conversation.round = (conversation.round || 0) + 1;
    conversation.updatedAt = new Date().toISOString();
    persist();
    return copyConversation(conversation);
  }

  function markStatus(id, status) {
    return update(id, { status: requireId(status, 'status') });
  }

  function persist() {
    storage.atomicWrite(statePath, JSON.stringify(state, null, 2));
  }

  function requireConversation(id) {
    const conversationId = requireId(id, 'id');
    const conversation = state.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error(`Conversation not found: ${conversationId}`);
    return conversation;
  }

  return { list, listByAgent, create, get, clear, update, advanceRound, markStatus, persist };
}

function readState(storage, statePath) {
  try {
    const content = storage.readFile(statePath);
    return content ? JSON.parse(content) : DEFAULT_STATE;
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.message === 'ENOENT')) return DEFAULT_STATE;
    throw error;
  }
}

function normalizeState(value) {
  const conversations = Array.isArray(value?.conversations) ? value.conversations : [];
  return {
    conversations: conversations.map((conversation) => ({
      ...copyValue(conversation),
      agentId: requireId(conversation.agentId, 'agentId')
    }))
  };
}

function copyConversation(conversation) {
  return copyValue(conversation);
}

function copyValue(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function requireId(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  return value;
}

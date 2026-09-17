// Provides role-scoped conversation IDs and fan-out stream helpers.
'use strict';

const ROLES = Object.freeze(['AM', 'SL', 'BU', 'RV']);

// Builds a role-scoped conversation identifier.
function conversationId(role, projectId, ticketId) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  if (!ROLES.includes(normalizedRole)) {
    throw new TypeError(`Unsupported agent role: ${role}`);
  }
  if (!projectId || !ticketId) {
    throw new TypeError('projectId and ticketId are required');
  }
  return `CONV-${normalizedRole}-${projectId}-${ticketId}`;
}

// Fans out role-specific conversation streams.
function roleStreams({ projectId, ticketId, roles = ROLES, stream }) {
  if (typeof stream !== 'function') throw new TypeError('stream must be a function');
  return [...roles].map((role) => {
    const id = conversationId(role, projectId, ticketId);
    return Promise.resolve(stream({ role, conversation_id: id }));
  });
}

// Creates a deduplicator for incoming messages.
function createMessageDeduper() {
  const seen = new Set();
  return (message) => {
    const id = message && (message.messageId || message.id);
    if (!id) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  };
}

module.exports = { ROLES, conversationId, roleStreams, createMessageDeduper };

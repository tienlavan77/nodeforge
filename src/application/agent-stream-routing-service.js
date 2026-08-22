'use strict';

/**
 * Routes a direct assignment to the role-specific conversation. The service is
 * deliberately transport agnostic: agentGateway.stream may return an async
 * iterable, a promise, or accept an onEvent callback.
 */
class AgentStreamRoutingService {
  constructor({ agentGateway, roadmapStore, agentToolDefinition, batchWindowMs = 500, clock = () => Date.now() } = {}) {
    if (!agentGateway || typeof agentGateway.stream !== 'function') throw new TypeError('agentGateway.stream is required');
    this.agentGateway = agentGateway;
    this.roadmapStore = roadmapStore;
    this.agentToolDefinition = agentToolDefinition;
    this.batchWindowMs = batchWindowMs;
    this.clock = clock;
    this.seen = new Set();
  }

  conversationId(role, projectId, ticketId) {
    return `CONV-${String(role).toUpperCase()}-${projectId}-${ticketId}`;
  }

  async route({ projectId, ticketId, text, roles = ['AM', 'SL', 'BU', 'RV'], onEvent } = {}) {
    if (!projectId || !ticketId || !text) throw new TypeError('projectId, ticketId and text are required');
    const ticket = await this.lookupTicket(projectId, ticketId);
    if (!ticket) throw new Error(`Unknown ticket: ${ticketId}`);
    const selected = roles.filter(Boolean).map((role) => String(role).toUpperCase());
    await Promise.all(selected.map((role) => this.streamRole({ role, projectId, ticketId, text, ticket, onEvent })));
    return selected.map((role) => this.conversationId(role, projectId, ticketId));
  }

  async lookupTicket(projectId, ticketId) {
    if (!this.roadmapStore) return { id: ticketId, project_id: projectId };
    const methods = ['getTicket', 'findTicket', 'lookupTicket'];
    for (const method of methods) {
      if (typeof this.roadmapStore[method] === 'function') {
        const result = await this.roadmapStore[method](projectId, ticketId);
        if (result) return result;
      }
    }
    return null;
  }

  async streamRole({ role, projectId, ticketId, text, ticket, onEvent }) {
    const conversationId = this.conversationId(role, projectId, ticketId);
    const input = { role, projectId, ticketId, ticket, text, conversation_id: conversationId, conversationId };
    if (this.agentToolDefinition && typeof this.agentToolDefinition.validate === 'function') {
      await this.agentToolDefinition.validate(input);
    }
    const emit = (event) => {
      const id = event && (event.messageId || event.message_id || event.id);
      if (id && this.seen.has(`${conversationId}:${id}`)) return;
      if (id) this.seen.add(`${conversationId}:${id}`);
      if (onEvent) onEvent({ ...event, conversation_id: conversationId, conversationId });
    };
    emit({ type: 'agent.started', role, conversation_id: conversationId, at: this.clock() });
    try {
      const result = await this.agentGateway.stream(input);
      if (result && result[Symbol.asyncIterator]) {
        let prose = '';
        let timer;
        const flush = () => { if (prose) { emit({ type: 'agent.prose', delta: prose }); prose = ''; } };
        for await (const event of result) {
          if (event && typeof event.delta === 'string') {
            prose += event.delta;
            clearTimeout(timer);
            timer = setTimeout(flush, this.batchWindowMs);
          } else { flush(); emit(event); }
        }
        clearTimeout(timer); flush();
      }
      emit({ type: 'agent.completed', role, status: 'completed' });
    } catch (error) {
      emit({ type: 'agent.failed', role, status: 'failed', error: error.message, code: error.code || 'AGENT_STREAM_FAILED' });
      throw error;
    }
  }
}

function parseDirectAssignment(text) {
  const value = String(text || '').trim();
  const match = value.match(/\b(NF-[A-Z0-9]+-T\d+)\b/i);
  if (!match) return null;
  return { ticketId: match[1].toUpperCase(), text: value };
}

module.exports = AgentStreamRoutingService;
module.exports.AgentStreamRoutingService = AgentStreamRoutingService;
module.exports.parseDirectAssignment = parseDirectAssignment;

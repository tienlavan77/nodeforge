'use strict';

const ROLE_NAMES = ['AM', 'SL', 'BU', 'RV'];

function conversationId(role, projectId, ticketId) {
  const normalizedRole = String(role || '').trim().toUpperCase();
  if (!ROLE_NAMES.includes(normalizedRole)) throw new TypeError(`Unknown agent role: ${role}`);
  if (!projectId || !ticketId) throw new TypeError('projectId and ticketId are required');
  return `CONV-${normalizedRole}-${projectId}-${ticketId}`;
}

function extractTicketId(text) {
  const match = String(text || '').match(/\b(NF-[A-Z0-9]+-T\d+)\b/i);
  return match ? match[1].toUpperCase() : null;
}

/** Routes one owner request to role-specific streams without sharing conversation state. */
export class DirectChatStreamService {
  constructor({ roadmapStore, agentGateway, agentTool, roles = ROLE_NAMES, now = Date } = {}) {
    if (!roadmapStore || typeof roadmapStore.getByTicketId !== 'function') throw new TypeError('roadmapStore.getByTicketId is required');
    if (!agentGateway || typeof agentGateway.stream !== 'function') throw new TypeError('agentGateway.stream is required');
    this.roadmapStore = roadmapStore;
    this.agentGateway = agentGateway;
    this.agentTool = agentTool;
    this.roles = roles.map((role) => String(role).toUpperCase());
    this.now = now;
  }

  async dispatch({ projectId, text, messageId }) {
    const ticketId = extractTicketId(text);
    if (!ticketId) throw new Error('A ticket id such as NF-SVC-T01 is required');
    const ticket = await this.roadmapStore.getByTicketId(ticketId);
    if (!ticket) throw new Error(`Ticket not found: ${ticketId}`);
    const request = { projectId, ticketId, text: String(text), messageId, receivedAt: new this.now().toISOString() };
    if (this.agentTool) {
      const validation = typeof this.agentTool.validate === 'function'
        ? await this.agentTool.validate(request)
        : (typeof this.agentTool.parse === 'function' ? await this.agentTool.parse(request) : true);
      if (validation === false) throw new Error('Owner request failed agent-tool validation');
    }
    const streams = await Promise.all(this.roles.map(async (role) => {
      const id = conversationId(role, projectId, ticketId);
      return { role, conversationId: id, stream: await this.agentGateway.stream({ ...request, ticket, role, conversation_id: id }) };
    }));
    return { ticketId, streams };
  }
}

export { conversationId, extractTicketId, ROLE_NAMES };

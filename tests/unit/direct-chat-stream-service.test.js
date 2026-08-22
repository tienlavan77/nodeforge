'use strict';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectChatStreamService, conversationId, extractTicketId } from '../../src/application/direct-chat-stream-service.js';

test('extracts natural-language NF ticket ids and builds isolated conversations', () => {
  assert.equal(extractTicketId('làm NF-SVC-T01 giúp tôi'), 'NF-SVC-T01');
  assert.equal(conversationId('bu', 'PROJECT-114A', 'NF-SVC-T01'), 'CONV-BU-PROJECT-114A-NF-SVC-T01');
});

test('validates and streams one request per role with distinct conversation ids', async () => {
  const calls = [];
  const service = new DirectChatStreamService({
    roadmapStore: { getByTicketId: async () => ({ title: 'ticket' }) },
    agentTool: { validate: async () => true },
    agentGateway: { stream: async (request) => { calls.push(request); return request.conversation_id; } },
    roles: ['AM', 'BU']
  });
  const result = await service.dispatch({ projectId: 'PROJECT-114A', text: 'làm NF-SVC-T01' });
  assert.deepEqual(calls.map((call) => call.conversation_id), [
    'CONV-AM-PROJECT-114A-NF-SVC-T01',
    'CONV-BU-PROJECT-114A-NF-SVC-T01'
  ]);
  assert.deepEqual(result.streams.map((stream) => stream.conversationId), calls.map((call) => call.conversation_id));
});

test('rejects requests for missing tickets before opening a stream', async () => {
  let streamed = false;
  const service = new DirectChatStreamService({
    roadmapStore: { getByTicketId: async () => null },
    agentGateway: { stream: async () => { streamed = true; } }
  });
  await assert.rejects(() => service.dispatch({ projectId: 'P', text: 'do NF-SVC-T01' }), /Ticket not found/);
  assert.equal(streamed, false);
});

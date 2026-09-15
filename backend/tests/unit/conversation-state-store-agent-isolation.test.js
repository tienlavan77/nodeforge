import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationStateStore } from '../../src/modules/protocol/conversation-state-store.js';

function createStorage() {
  let value = '';
  return {
    readFile() {
      return value;
    },
    atomicWrite(_path, nextValue) {
      value = nextValue;
    }
  };
}

test('conversation retrieval is isolated by the selected agent id', () => {
  const store = createConversationStateStore({ storage: createStorage() });

  store.create({ id: 'architecture-1', agentId: 'architecture-manager-v2', title: 'Architecture' });
  store.create({ id: 'delivery-1', agentId: 'delivery-manager-v2', title: 'Delivery' });
  store.create({ id: 'architecture-2', agentId: 'architecture-manager-v2', title: 'Follow-up' });

  assert.deepEqual(
    store.listByAgent('architecture-manager-v2').map(({ id }) => id),
    ['architecture-1', 'architecture-2']
  );
  assert.deepEqual(
    store.listByAgent('delivery-manager-v2').map(({ id }) => id),
    ['delivery-1']
  );
  assert.deepEqual(store.listByAgent('another-agent-v2'), []);
});

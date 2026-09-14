import assert from "node:assert/strict";
import test from "node:test";

import { createConversationStateStore } from "../../src/modules/protocol/conversation-state-store.js";

function store() {
  return createConversationStateStore({
    fileService: {
      async readFile() { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
      async atomicWrite() {}
    }
  });
}

test("conversation retrieval is isolated by the currently selected agent ID", async () => {
  const conversations = store();
  await conversations.create({ conversationId: "conversation-a", taskId: "task-a", agentId: "architecture-manager-v2" });
  await conversations.create({ conversationId: "conversation-b", taskId: "task-b", agentId: "builder-v2" });

  assert.deepEqual((await conversations.listByAgent("architecture-manager-v2")).map(({ conversation_id }) => conversation_id), ["conversation-a"]);
  assert.deepEqual((await conversations.list({ agentId: "builder-v2" })).map(({ conversation_id }) => conversation_id), ["conversation-b"]);
  assert.deepEqual((await conversations.list()).map(({ conversation_id }) => conversation_id), ["conversation-a", "conversation-b"]);
});

// Verify owner-message actions are composed into both conversation workspaces.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const actions = await readFile("ui/nextjs/components/conversation-message-actions.jsx", "utf8");
const handler = await readFile("ui/nextjs/lib/home-page-message-handlers.js", "utf8");
const home = await readFile("ui/nextjs/app/page.jsx", "utf8");
const system = await readFile("ui/nextjs/app/system/page.jsx", "utf8");

// Keep the three owner actions available without changing the conversation transport contract.
test("owner message actions provide copy, edit, and retry behavior", () => {
  assert.ok(actions.includes("navigator.clipboard?.writeText"));
  assert.ok(actions.includes('"Copy message"'));
  assert.ok(actions.includes('aria-label="Edit message"'));
  assert.ok(actions.includes('aria-label="Retry message"'));
  assert.ok(actions.includes('aria-label="Save edited message"'));
  assert.ok(actions.includes('editing ? <div className="claude-message-inline-edit"'));
  assert.ok(handler.includes("async function editMessage"));
  assert.ok(handler.includes("async function retryMessage"));
  assert.ok(handler.includes("supersedesMessageId: message.id"));
  for (const page of [home, system]) {
    assert.ok(page.includes("ConversationMessageActions"));
    assert.ok(page.includes("onEdit={editMessage}"));
    assert.ok(page.includes("message.from === \"owner\""));
    assert.ok(page.includes("onRetry={(ownerMessage) => retryMessage(ownerMessage, activeConversationId)}"));
  }
});

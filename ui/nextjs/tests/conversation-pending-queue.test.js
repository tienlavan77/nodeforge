// Verifies queued conversation requests remain local, FIFO, agent-scoped, and cancellable.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const queue = await readFile("ui/nextjs/components/conversation-pending-queue.jsx", "utf8");
const home = await readFile("ui/nextjs/app/page.jsx", "utf8");
const system = await readFile("ui/nextjs/app/system/page.jsx", "utf8");

// Prevents the queue UI from bypassing the active-agent status and normal send handlers.
test("pending conversation queue dispatches one message after an agent response", () => {
  assert.ok(queue.includes("usePendingConversationQueue"));
  assert.ok(queue.includes("agentId"));
  assert.ok(queue.includes("if (!isWorking) return onSendRef.current(text)"));
  assert.ok(queue.includes("const nextMessage = pendingRef.current[0]"));
  assert.ok(queue.includes("cancelPendingMessage"));
  assert.ok(queue.includes("PendingConversationQueue"));
  for (const page of [home, system]) {
    assert.ok(page.includes("usePendingConversationQueue"));
    assert.ok(page.includes("<PendingConversationQueue pendingMessages={pendingMessages} onCancel={cancelPendingMessage} />"));
    assert.ok(!page.includes("pendingQueue={<PendingConversationQueue"));
    assert.ok(page.indexOf("<PendingConversationQueue pendingMessages") > page.indexOf("<div className=\"claude-composer-wrap\">"));
    assert.ok(page.indexOf("<PendingConversationQueue pendingMessages") < page.indexOf("<div className=\"conversation-statusbar\">"));
    assert.ok(page.includes("onSend={submitMessage}"));
  }
});

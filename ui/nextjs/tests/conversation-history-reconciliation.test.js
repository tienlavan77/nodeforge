// Verifies reconnect recovery preserves history and replaces missed or partial agent replies without duplicates.
import assert from "node:assert/strict";
import test from "node:test";
import { reconcileConversationHistory } from "../lib/conversation-history-reconciliation.js";

test("persisted completion replaces a partial streamed reply and retains older messages and drafts", () => {
  const older = { id: "OLD", from: "owner", timestamp: "2026-10-13T00:00:00Z" };
  const partial = { id: "DELTA", from: "agent", stream_key: "agent:CORR-1", text: "Partial", timestamp: "2026-10-13T00:01:00Z", stream: true };
  const draft = { id: "DRAFT", from: "owner", pending: true, timestamp: "2026-10-13T00:03:00Z" };
  const completed = { id: "FINAL", from: "agent", correlation_id: "CORR-1", text: "Completed", timestamp: "2026-10-13T00:02:00Z" };
  const result = reconcileConversationHistory([older, partial, draft], [completed]);
  assert.deepEqual(result.map((message) => message.id), ["OLD", "FINAL", "DRAFT"]);
  assert.equal(result[1].text, "Completed");
  assert.equal(result[1].stream, false);
  assert.equal(result[1].stream_key, "agent:CORR-1");
  assert.deepEqual(reconcileConversationHistory(result, [completed]), result);
});

test("owner and agent sharing a correlation are not merged and unseen responses are recovered", () => {
  const owner = { id: "OWNER", from: "owner", correlation_id: "CORR-1", pending: true };
  const response = { id: "REPLY", from: "agent", correlation_id: "CORR-1", text: "Answer" };
  assert.equal(reconcileConversationHistory([owner], [response]).length, 2);
});

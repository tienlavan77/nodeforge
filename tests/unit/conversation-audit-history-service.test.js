import assert from "node:assert/strict";
import test from "node:test";

import { createConversationAuditHistoryService } from "../../src/application/conversation-audit-history-service.js";

test("returns chronological, filterable, redacted, cursor-paginated read-only history", () => {
  const communications = { getAll: () => [
    message("MSG-141-OWNER", "2026-08-21T09:00:00Z", "project-owner", "project_owner", "architecture-manager", "owner.message", { text: "Plan this work.", api_key: "do-not-expose" }),
    message("MSG-141-AGENT", "2026-08-21T09:01:00Z", "architecture-manager", "architecture_manager", "NODE", "architecture.message.received", { text: "Plan recorded." })
  ] };
  const eventStore = { getAll: () => [{ event_id: "EVT-141", event_type: "agent.completed", source: "architecture-manager", timestamp: "2026-08-21T09:02:00Z", payload: { result: "completed" }, metadata: { project_id: "PROJECT-141", agent_id: "architecture-manager", correlation_id: "CORR-141" } }] };
  const service = createConversationAuditHistoryService({ communications, eventStore });

  const first = service.query({ projectId: "PROJECT-141", limit: 2 });
  assert.deepEqual(first.items.map(({ id }) => id), ["MSG-141-OWNER", "MSG-141-AGENT"]);
  assert.equal(first.items[0].content.api_key, "[REDACTED]");
  assert.equal(first.next_cursor, "2");
  assert.deepEqual(service.query({ projectId: "PROJECT-141", agentId: "architecture-manager", type: "architecture.message.received" }).items.map(({ id }) => id), ["MSG-141-AGENT"]);
  assert.deepEqual(service.query({ projectId: "PROJECT-141", correlationId: "CORR-141", cursor: first.next_cursor }).items.map(({ id }) => id), ["EVT-141"]);
});

test("returns deterministic empty history and rejects invalid queries", () => {
  const service = createConversationAuditHistoryService({ communications: { getAll: () => [] } });
  assert.deepEqual(service.query({ projectId: "PROJECT-141" }), { items: [], next_cursor: null });
  assert.throws(() => service.query({ projectId: "", limit: 25 }), /project id/);
  assert.throws(() => service.query({ projectId: "PROJECT-141", limit: 0 }), /limit/);
});

function message(id, timestamp, sender, role, receiver, type, payload) {
  return { id, project_id: "PROJECT-141", sender: { id: sender, role }, recipient: { id: receiver, role: receiver === "NODE" ? "node" : "architecture_manager" }, message_type: type, conversation_id: "CONV-141", correlation_id: "CORR-141", payload, timestamp };
}

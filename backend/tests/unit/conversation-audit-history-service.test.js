import assert from "node:assert/strict";
import test from "node:test";

import { createConversationAuditHistoryService } from "../../src/application/conversation-audit-history-service.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

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

test("conversation transcript pages include saved messages instead of recent tool activity", async () => {
  const saved = [
    message("MSG-OWNER", "2026-08-21T09:00:00Z", "project-owner", "project_owner", "architecture-manager", "owner.message", { text: "Earlier request" }),
    message("MSG-REPLY", "2026-08-21T09:01:00Z", "architecture-manager", "architecture_manager", "NODE", "architecture.message.received", { text: "Earlier reply" }),
    ...Array.from({ length: 25 }, (_, index) => message(`MSG-ACTIVITY-${index}`, `2026-08-21T09:02:${String(index).padStart(2, "0")}Z`, "NODE", "node", "project-owner", "agent.activity", { summary: "Tool completed" }))
  ];
  const service = createConversationAuditHistoryService({ communications: { getAll: () => saved, getByConversationId: () => saved } });
  const routes = createForgeV1ConversationRoutes({ conversationCrudService: { get: () => ({ project_id: "PROJECT-141" }) }, conversationAuditHistoryService: service });
  const result = await routes.routeConversation({ method: "GET", parts: ["conversations", "CONV-141", "messages"], url: new URL("http://localhost/forge/v1/conversations/CONV-141/messages?limit=2&order=desc"), projectId: "PROJECT-141" });
  assert.deepEqual(result.body.items.map(({ id }) => id), ["MSG-REPLY", "MSG-OWNER"]);
  assert.equal(result.body.next_cursor, null);
  assert.equal(service.query({ projectId: "PROJECT-141", conversationId: "CONV-141", limit: 2, order: "desc" }).items[0].type, "agent.activity");
});

function message(id, timestamp, sender, role, receiver, type, payload) {
  return { id, project_id: "PROJECT-141", sender: { id: sender, role }, recipient: { id: receiver, role: receiver === "NODE" ? "node" : "architecture_manager" }, message_type: type, conversation_id: "CONV-141", correlation_id: "CORR-141", payload, timestamp };
}

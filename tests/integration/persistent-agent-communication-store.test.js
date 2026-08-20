import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openIndexDatabase } from "../../src/infrastructure/sqlite/index-database.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";

test("persists communication in append order across restart with deterministic queries and redaction", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-communication-143-"));
  let database = await openIndexDatabase(root);
  try {
    const first = createAgentCommunicationStore({ database });
    const owner = message("MSG-143-OWNER", "project-owner", "project_owner", "architecture-manager", "architecture_manager", "CONV-143", "CORR-143", { text: "Plan it.", api_key: "not-persisted" });
    const reply = message("MSG-143-REPLY", "architecture-manager", "architecture_manager", "NODE", "node", "CONV-143", "CORR-143", { text: "Recorded." });
    first.append(owner);
    first.append(reply);
    owner.payload.text = "mutated";
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createAgentCommunicationStore({ database });

    assert.deepEqual(restarted.getAll().map(({ id }) => id), ["MSG-143-OWNER", "MSG-143-REPLY"]);
    assert.equal(restarted.getById("MSG-143-OWNER").payload.api_key, "[REDACTED]");
    assert.equal(restarted.getById("MSG-143-OWNER").payload.text, "Plan it.");
    assert.deepEqual(restarted.getByConversationId("CONV-143").map(({ id }) => id), ["MSG-143-OWNER", "MSG-143-REPLY"]);
    assert.deepEqual(restarted.getByCorrelationId("CORR-143").map(({ id }) => id), ["MSG-143-OWNER", "MSG-143-REPLY"]);
    assert.deepEqual(restarted.getBySender("architecture-manager").map(({ id }) => id), ["MSG-143-REPLY"]);
    assert.deepEqual(restarted.getByReceiver("NODE").map(({ id }) => id), ["MSG-143-REPLY"]);
    assert.throws(() => restarted.append(reply), /already exists/);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("surfaces database persistence failures without retaining a message in memory", () => {
  const database = { all: () => [], run: () => { throw new Error("disk unavailable"); } };
  assert.throws(() => createAgentCommunicationStore({ database }), /disk unavailable/);
});

function message(id, senderId, senderRole, receiverId, receiverRole, conversationId, correlationId, payload) {
  return { id, project_id: "PROJECT-143", sender: { id: senderId, role: senderRole }, recipient: { id: receiverId, role: receiverRole }, message_type: "owner.message", conversation_id: conversationId, correlation_id: correlationId, payload, timestamp: "2026-08-21T13:00:00Z" };
}

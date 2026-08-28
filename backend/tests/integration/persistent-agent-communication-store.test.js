import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
    const indexRows = database.all("SELECT message_id, project_id, agent_id, conversation_id, raw_file, byte_offset, byte_length FROM agent_communications ORDER BY sequence");
    assert.deepEqual(indexRows.map(({ message_id, agent_id }) => [message_id, agent_id]), [["MSG-143-OWNER", "project-owner"], ["MSG-143-REPLY", "architecture-manager"]]);
    assert.equal(Object.hasOwn(indexRows[0], "message_json"), false);
    const raw = await readFile(join(root, ".forge", "runtime", indexRows[0].raw_file), "utf8");
    assert.equal(raw.includes("Plan it."), true);
    assert.equal(raw.includes("not-persisted"), false);
    assert.throws(() => restarted.append(reply), /already exists/);
  } finally {
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("isolates four agents by conversation while sharing the same file-backed index", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-communication-154-agents-"));
  const database = await openIndexDatabase(root);
  try {
    const store = createAgentCommunicationStore({ database });
    for (const agent of ["architecture-manager", "sprint-lead", "builder", "reviewer"]) {
      store.append(message(`MSG-154-${agent}`, agent, roleFor(agent), "NODE", "node", `CONV-154-${agent}`, `CORR-154-${agent}`, { text: agent }));
    }

    assert.deepEqual(store.getByConversationId("CONV-154-builder").map(({ sender }) => sender.id), ["builder"]);
    assert.deepEqual(store.getByConversationId("CONV-154-reviewer").map(({ sender }) => sender.id), ["reviewer"]);
    assert.equal(database.all("SELECT COUNT(*) AS count FROM agent_communications WHERE conversation_id = ?", ["CONV-154-builder"])[0].count, 1);
    assert.equal(database.all("SELECT COUNT(*) AS count FROM agent_communications WHERE agent_id = ?", ["sprint-lead"])[0].count, 1);
  } finally {
    await database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("migrates existing SQLite raw messages into file-backed storage without deleting the legacy table", async () => {
  const root = await mkdtemp(join(os.tmpdir(), "nodeforge-communication-154-migration-"));
  let database = await openIndexDatabase(root);
  try {
    database.run(`CREATE TABLE agent_communications (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      sender_id TEXT NOT NULL,
      receiver_id TEXT NOT NULL,
      conversation_id TEXT,
      correlation_id TEXT,
      message_json TEXT NOT NULL
    )`);
    const legacy = message("MSG-LEGACY-154", "project-owner", "project_owner", "architecture-manager", "architecture_manager", "CONV-LEGACY-154", "CORR-LEGACY-154", { text: "legacy", secret: "do-not-copy" });
    database.run("INSERT INTO agent_communications (message_id, sender_id, receiver_id, conversation_id, correlation_id, message_json) VALUES (?, ?, ?, ?, ?, ?)", [legacy.id, legacy.sender.id, legacy.recipient.id, legacy.conversation_id, legacy.correlation_id, JSON.stringify(legacy)]);

    const migrated = createAgentCommunicationStore({ database });

    assert.equal(migrated.getById("MSG-LEGACY-154").payload.text, "legacy");
    assert.equal(migrated.getById("MSG-LEGACY-154").payload.secret, "[REDACTED]");
    assert.equal(database.all("SELECT COUNT(*) AS count FROM agent_communications_legacy_raw")[0].count, 1);
    assert.equal(database.all("SELECT COUNT(*) AS count FROM agent_communications WHERE message_id = ?", ["MSG-LEGACY-154"])[0].count, 1);
    const row = database.all("SELECT raw_file FROM agent_communications WHERE message_id = ?", ["MSG-LEGACY-154"])[0];
    const raw = await readFile(join(root, ".forge", "runtime", row.raw_file), "utf8");
    assert.equal(raw.includes("legacy"), true);
    assert.equal(raw.includes("do-not-copy"), false);
    await database.close();
    database = await openIndexDatabase(root);
    const restarted = createAgentCommunicationStore({ database });
    assert.deepEqual(restarted.getByConversationId("CONV-LEGACY-154").map(({ id }) => id), ["MSG-LEGACY-154"]);
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

function roleFor(agent) {
  return agent === "architecture-manager" ? "architecture_manager" : agent.replace("-", "_");
}

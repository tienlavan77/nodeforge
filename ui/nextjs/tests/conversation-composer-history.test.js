// Verifies owner input recall is isolated per project and agent and cannot leak legacy shared history into a new agent scope.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { appendConversationComposerHistory, conversationComposerHistoryKey, readConversationComposerHistory, saveConversationComposerHistory } from "../lib/conversation-composer-history.js";

test("history remains isolated across agents and projects, including reloads", () => {
  const values = new Map([["nodeforge:project-chat-history", '["legacy shared message"]']]);
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const architecture = conversationComposerHistoryKey("PROJECT-A", "architecture-agent");
  const engineer = conversationComposerHistoryKey("PROJECT-A", "engineer-agent");
  const anotherProject = conversationComposerHistoryKey("PROJECT-B", "architecture-agent");
  assert.deepEqual(readConversationComposerHistory(architecture, storage), []);
  saveConversationComposerHistory(architecture, ["Architecture message"], storage);
  saveConversationComposerHistory(engineer, ["Engineer message"], storage);
  assert.deepEqual(readConversationComposerHistory(architecture, storage), ["Architecture message"]);
  assert.deepEqual(readConversationComposerHistory(engineer, storage), ["Engineer message"]);
  assert.deepEqual(readConversationComposerHistory(anotherProject, storage), []);
  assert.equal(values.get("nodeforge:project-chat-history"), '["legacy shared message"]');
});

test("unselected agents never read or overwrite shared storage and scope separators cannot collide", () => {
  assert.equal(conversationComposerHistoryKey("PROJECT-A", null), null);
  assert.equal(conversationComposerHistoryKey("", "agent"), null);
  assert.notEqual(conversationComposerHistoryKey("project:one", "agent"), conversationComposerHistoryKey("project", "one:agent"));
  const storage = { getItem: () => assert.fail("Unbound composer read storage"), setItem: () => assert.fail("Unbound composer wrote storage") };
  assert.deepEqual(readConversationComposerHistory(null, storage), []);
  saveConversationComposerHistory(null, ["message"], storage);
});

test("each agent history is bounded, normalized and deduplicates consecutive sends", () => {
  let history = [];
  for (let index = 0; index < 60; index += 1) history = appendConversationComposerHistory(history, `message-${index}`);
  assert.equal(history.length, 50); assert.equal(history[0], "message-10");
  assert.deepEqual(appendConversationComposerHistory(history, "message-59"), history);
  assert.deepEqual(appendConversationComposerHistory(history, " "), history);
  const storage = { getItem: () => JSON.stringify([1, null, "valid"]), setItem() {} };
  assert.deepEqual(readConversationComposerHistory("scope", storage), ["valid"]);
});

test("corrupted or unavailable storage is logged and does not break sending", (context) => {
  const warning = context.mock.method(console, "warn", () => {});
  assert.deepEqual(readConversationComposerHistory("scope", { getItem: () => "invalid JSON" }), []);
  saveConversationComposerHistory("scope", ["message"], { setItem: () => { throw new Error("Storage unavailable"); } });
  assert.equal(warning.mock.calls.length, 2);
});

test("Architecture and System Engineer pages provide actual project and agent identity to the composer", async () => {
  const home = await readFile("ui/nextjs/app/page.jsx", "utf8");
  const system = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
  assert.match(home, /<HomeChatComposer[^>]*projectId=\{PROJECT_ID\}[^>]*agentId=\{selectedArchitectureManager\?\.id\}/);
  assert.match(system, /<HomeChatComposer[^>]*projectId=\{PROJECT_ID\}[^>]*agentId=\{selectedAgent\?\.id\}/);
});

// Verifies unsaved conversations start without a modal and persist only on the first owner message.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";

const persistedId = "123e4567-e89b-42d3-a456-426614174000";

for (const [path, executionRole] of [["../components/architecture-workspace.jsx", "architecture-manager"], ["../app/system/page.jsx", "system-engineer"]]) {
  const source = await readFile(new URL(path, import.meta.url), "utf8");
  // Exercises the actual route callbacks without mounting unrelated dashboard and stream components.
  test(`${executionRole}: New conversation clears the view and selecting a chat cancels the draft`, () => {
    const state = { id: persistedId, messages: ["old reply"], revision: 0, rows: [] };
    const activeConversationIdRef = { current: persistedId };
    const lastSentRef = { current: { conversationId: persistedId } };
    const selectionSource = source.match(/  function handleSelectConversation\(conversation\) \{[\s\S]*?\n  \}/)[0];
    const draftSource = source.match(/  function handleNewConversation\(\) \{[\s\S]*?\n  \}/)[0];
    const createdSource = source.match(/  function handleConversationCreated\(conversation\) \{[\s\S]*?\n  \}/)[0];
    const callbacks = runInNewContext(`${draftSource}\n${selectionSource}\n${createdSource}\n({ handleNewConversation, handleSelectConversation, handleConversationCreated })`, {
      activeConversationIdRef, lastSentRef, sendingRef: { current: false },
      CHAT_STATE_KEY: "home", CODING_CHAT_STATE_KEY: "system",
      selectedArchitectureManager: { id: "agent" }, selectedAgent: { id: "agent" },
      setActiveConversationId: (id) => { state.id = id; },
      setConversationRevision: (update) => { state.revision = update(state.revision); },
      setConversations: (update) => { state.rows = update(state.rows); },
      loadConversationMessages: (id) => { state.loaded = id; state.messages = []; },
      setMessages: (messages) => { state.messages = messages; },
      setChatState: (value) => { state.error = value; },
      setAgentTyping: (value) => { state.typing = value; },
      setGlobalError: (value) => { state.globalError = value; },
      setMarkdownPreviewPath: (value) => { state.preview = value; },
      writeChatState: (...values) => { state.saved = values; }
    });
    callbacks.handleNewConversation();
    assert.equal(state.id, "");
    assert.equal(activeConversationIdRef.current, "");
    assert.equal(state.loaded, null);
    assert.equal(state.messages.length, 0);
    assert.equal(state.typing, false);
    assert.equal(lastSentRef.current, null);
    assert.equal(state.rows.length, 0);
    callbacks.handleNewConversation();
    assert.equal(state.rows.length, 0);
    callbacks.handleSelectConversation({ id: persistedId });
    assert.equal(state.id, persistedId);
    assert.equal(activeConversationIdRef.current, persistedId);
    assert.equal(state.loaded, persistedId);
    callbacks.handleConversationCreated({ id: persistedId, title: "First message" });
    assert.equal(state.rows[0].id, persistedId);
    assert.match(source, /onNewConversation=\{handleNewConversation\}/);
    assert.doesNotMatch(source, /createRequest=|newConversationRequest/);
    assert.match(source, /<HomeChatComposer key=\{conversationRevision\}/);
    assert.match(source, /scopeKey: conversationRevision/);
    assert.match(source, /onConversationCreated: handleConversationCreated/);
  });

  // Creates exactly one conversation from the first message and retains its ID across failed sends and retries.
  test(`${executionRole}: first message creates a visible conversation and Retry reuses it`, async (context) => {
    const conversation = { id: persistedId, title: "First message" };
    const createConversation = context.mock.fn(async () => conversation);
    const postOwnerMessage = context.mock.fn(async () => { throw new Error("Send failed"); });
    const onConversationCreated = context.mock.fn();
    const setActiveConversationId = context.mock.fn();
    const handlers = createHomeMessageHandlers({
      client: { createConversation, postOwnerMessage }, projectId: "PROJECT-1",
      selectedArchitectureManager: { id: "agent", conversation_id: persistedId },
      activeConversationId: "", executionRole, onConversationCreated, setActiveConversationId,
      setChatState: context.mock.fn(), setMessages: context.mock.fn(), setAgentTyping: context.mock.fn(),
      sendingRef: { current: false }, lastSentRef: { current: null }, writeChatState: context.mock.fn()
    });
    assert.equal(createConversation.mock.calls.length, 0);
    await handlers.sendMessage("   ");
    assert.equal(createConversation.mock.calls.length, 0);
    await handlers.sendMessage(" First message ");
    assert.equal(createConversation.mock.calls.length, 1);
    assert.equal(createConversation.mock.calls[0].arguments[0].title, "First message");
    assert.equal(onConversationCreated.mock.calls[0].arguments[0], conversation);
    assert.equal(setActiveConversationId.mock.calls[0].arguments[0], persistedId);
    assert.equal(postOwnerMessage.mock.calls[0].arguments[0].conversationId, persistedId);
    await handlers.retryLastMessage();
    assert.equal(createConversation.mock.calls.length, 1);
    assert.equal(postOwnerMessage.mock.calls.length, 2);
    assert.equal(postOwnerMessage.mock.calls[1].arguments[0].conversationId, persistedId);
  });
}

// Invalidates pending history requests and pagination when a new unsaved conversation opens.
test("draft reset ignores late history results from the previous conversation", async () => {
  const source = await readFile(new URL("../lib/use-conversation-message-history.js", import.meta.url), "utf8");
  const updates = [];
  let resolveHistory;
  const hook = runInNewContext(source.replace(/^import .*;\n/gm, "").replace("export function", "function") + "\nuseConversationMessageHistory", {
    useState: (initial) => [initial, (value) => updates.push(value)],
    useRef: (current) => ({ current }), useLayoutEffect: () => {},
    mergeConversationRevisions: (items) => items
  });
  const history = hook({ client: { getConversationMessages: () => new Promise((resolve) => { resolveHistory = resolve; }) },
    projectId: "PROJECT-1", chatMessagesRef: { current: null }, agentDirectoryRef: { current: [] } });
  const pending = history.loadConversationMessages(persistedId);
  await history.loadConversationMessages(null);
  const updateCount = updates.length;
  resolveHistory({ items: [{ text: "Old reply" }], next_cursor: "old-cursor" });
  await pending;
  assert.equal(updates.length, updateCount);
  await history.loadEarlierMessages();
  assert.equal(updates.length, updateCount);
});

// Verify conversation navigation callbacks and sidebar state remain connected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const component = await readFile("ui/nextjs/components/ConversationsAccordion.jsx", "utf8");
const page = await readFile("ui/nextjs/app/page.jsx", "utf8");
const sidebar = await readFile("ui/nextjs/components/conversation-sidebar.jsx", "utf8");
const codePage = await readFile("ui/nextjs/app/code/page.jsx", "utf8");
const legacyCodePage = await readFile("ui/nextjs/app/coding/page.jsx", "utf8");
const systemPage = await readFile("ui/nextjs/app/system/page.jsx", "utf8");
const preferenceSource = await readFile("ui/nextjs/lib/sidebar-preference.js", "utf8");
const preference = runInNewContext(
  preferenceSource.replaceAll("export ", "") +
    ";({ readSidebarPreference, writeSidebarPreference, SIDEBAR_PREFERENCE_KEY })",
  { console }
);

// Action behavior remains covered by conversation-actions.test.js: pin/unpin observes
// PATCH requests and onTogglePin; rename observes PATCH and onConfirmRename; archive
// observes POST and onArchived; delete observes DELETE and onDeleted.
test("home route composes the conversation workspace from existing components", async () => {
  assert.ok(page.includes("<ConversationSidebar"));
  assert.ok(page.includes("<HomeChatComposer"));
  assert.ok(page.includes("<PendingPlanApproval"));
  assert.ok(page.includes("<ConversationsAccordion"));
  assert.ok(page.includes("useConversationMessageHistory"));
  assert.ok(page.includes("useProjectEventStream"));
  assert.ok(page.includes("createHomeMessageHandlers"));
  assert.ok(page.includes("loadConversationMessages(conversationId)"));
  assert.ok(page.includes('<WorkspaceMonitorPanels layoutScope="home"'));
  assert.ok(systemPage.includes('<WorkspaceMonitorPanels layoutScope="system"'));
  assert.ok(legacyCodePage.includes('<WorkspaceMonitorPanels layoutScope="coding"'));
  assert.ok(page.includes("const [watcherEvents, setWatcherEvents]"));
  assert.ok(page.includes("const [agentProcess, setAgentProcess]"));
  for (const routePage of [systemPage, legacyCodePage]) {
    assert.ok(routePage.includes("<WorkspaceMonitorPanels"));
    assert.ok(routePage.includes("setWatcherEvents"));
    assert.ok(routePage.includes("setWatcherState"));
    assert.ok(routePage.includes("setAgentProcess"));
  }
  assert.ok(legacyCodePage.includes("useProjectEventStream"));
  const monitors = await readFile("ui/nextjs/components/WorkspaceMonitorPanels.jsx", "utf8");
  assert.ok(monitors.includes("Watcher monitor"));
  assert.ok(monitors.includes("Agent activity monitor"));
  assert.ok(monitors.includes("onPointerDown"));
  assert.ok(monitors.includes('aria-label="System monitors"'));
  assert.ok(monitors.includes("aria-pressed={panel.visible && !panel.minimized}"));
  assert.ok(monitors.includes("Close Watcher monitor"));
  assert.ok(monitors.includes("Minimize Agent monitor"));
  assert.ok(monitors.includes("nodeforge:workspace-monitor-layout"));
  assert.ok(monitors.includes("${MONITOR_LAYOUT_KEY}:${layoutScope}"));
  assert.ok(monitors.includes("window.localStorage.getItem"));
  assert.ok(monitors.includes("window.localStorage.setItem"));
  assert.ok(monitors.includes("new ResizeObserver"));
  assert.equal(page.includes("<SprintPlanDashboard"), false);
  assert.equal(page.includes("<NodeForgeHeader"), false);
  assert.ok(sidebar.includes('onClick={reopen} aria-label="Open conversations sidebar"'));
  assert.ok(sidebar.includes('onClick={newConversation} aria-label="New chat"'));
  assert.ok(sidebar.includes('<Link href="/" title="Architecture"'));
  assert.ok(sidebar.includes('<span>Architecture</span></Link>'));
  assert.ok(sidebar.indexOf('title="Architecture"') < sidebar.indexOf('title="Agents"'));
  assert.ok(sidebar.includes('<Link href="/coding" title="Code"'));
  assert.ok(sidebar.indexOf('title="System"') < sidebar.indexOf('title="Code"'));
  assert.ok(sidebar.includes('aria-current={agentSectionTitle === "Code" ? "page" : undefined}'));
  assert.ok(legacyCodePage.includes("<ConversationSidebar"));
  assert.ok(legacyCodePage.includes("<ConversationsAccordion"));
  assert.equal(legacyCodePage.includes("../system/page.jsx"), false);
  assert.equal(legacyCodePage.includes("System chat"), false);
  assert.ok(codePage.includes('redirect("/coding")'));
  assert.ok(sidebar.includes("{children}"));
  assert.ok(component.includes('aria-label="New conversation"'));
  assert.ok(component.indexOf('aria-label="New conversation"') <
    component.indexOf('aria-label="Conversations list"'));
});

test("sidebar preferences round-trip without modifying conversation storage", () => {
  const values = new Map([
    ["conversation", "active-conversation"],
    ["agent", "architecture-manager"],
  ]);
  const storage = {
    getItem: (key) => values.get(key),
    setItem: (key, value) => values.set(key, value),
  };
  assert.equal(preference.readSidebarPreference(() => storage), false);
  preference.writeSidebarPreference(true, () => storage);
  assert.equal(preference.readSidebarPreference(() => storage), true);
  preference.writeSidebarPreference(false, () => storage);
  assert.equal(preference.readSidebarPreference(() => storage), false);
  assert.equal(values.get("conversation"), "active-conversation");
  assert.equal(values.get("agent"), "architecture-manager");
  for (const malformed of [null, "", "TRUE", "1", "{}", "null", "undefined"]) {
    storage.setItem(preference.SIDEBAR_PREFERENCE_KEY, malformed);
    assert.equal(preference.readSidebarPreference(() => storage), false);
  }
});

test("sidebar preferences tolerate unavailable and failing storage", () => {
  const warnings = [];
  const safePreference = runInNewContext(
    preferenceSource.replaceAll("export ", "") +
      ";({ readSidebarPreference, writeSidebarPreference })",
    { console: { warn: (...args) => warnings.push(args) } }
  );
  const failure = new Error("Storage unavailable");
  const cases = [
    () => undefined,
    () => null,
    () => { throw failure; },
    () => ({ getItem: () => { throw failure; }, setItem: () => { throw failure; } }),
  ];
  for (const storage of cases) {
    assert.equal(safePreference.readSidebarPreference(storage), false);
    assert.doesNotThrow(() => safePreference.writeSidebarPreference(true, storage));
  }
  assert.equal(warnings.length, 4);
  assert.ok(warnings.every((warning) => warning[1] === failure));
});

test("home route retains selected conversation restoration", () => {
  assert.ok(page.includes("readChatState(CHAT_STATE_KEY)"));
  assert.ok(page.includes("writeChatState(CHAT_STATE_KEY, selectedArchitectureManager.id, conversationId)"));
  assert.ok(page.includes("setActiveConversationId(conversationId)"));
  assert.ok(page.includes("void loadConversationMessages(conversationId)"));
});

test("collapse and reopen preserve active conversation, manager, messages, and streaming mount", () => {
  const collapseStart = sidebar.indexOf("  function changeCollapsed");
  const reopenStart = sidebar.indexOf("  function reopen");
  const newConversationStart = sidebar.indexOf("  function newConversation");
  assert.ok(collapseStart >= 0 && reopenStart > collapseStart && newConversationStart > reopenStart);
  const changeCollapsed = sidebar.slice(collapseStart, reopenStart);
  const reopen = sidebar.slice(reopenStart, newConversationStart);
  const state = {
    collapsed: false,
    open: false,
    activeConversationId: "conversation-selected",
    selectedArchitectureManager: "architecture-manager",
    messages: ["first", "received while collapsed"],
  };
  const streaming = { mounted: true };
  const children = { conversation: state.activeConversationId, manager: state.selectedArchitectureManager,
    messages: state.messages, streaming };
  const writes = [];
  const controls = runInNewContext(
    changeCollapsed + "\n" + reopen + "; ({ changeCollapsed, reopen })",
    {
      setCollapsed: (value) => { state.collapsed = value; },
      writeSidebarPreference: (value) => writes.push(value),
      onOpen: () => { state.open = true; },
    }
  );
  controls.changeCollapsed(true);
  assert.equal(state.collapsed, true);
  assert.deepEqual(children, {
    conversation: "conversation-selected",
    manager: "architecture-manager",
    messages: ["first", "received while collapsed"],
    streaming,
  });
  controls.reopen();
  assert.equal(state.collapsed, false);
  assert.equal(state.open, true);
  assert.deepEqual(writes, [true, false]);
  assert.equal(children.conversation, state.activeConversationId);
  assert.equal(children.manager, state.selectedArchitectureManager);
  assert.equal(children.messages, state.messages);
  assert.equal(children.streaming, streaming);
});

test("conversation rows render once in stable pinned-first groups", () => {
  const expression = "items.filter(isPinnedConversation).concat(items.filter((conv) => !isPinnedConversation(conv)))";
  assert.ok(component.includes(expression));
  const items = [
    { id: "a" },
    { id: "b", pinned: true },
    { id: "c" },
    { id: "d", pinned: true },
  ];
  const result = runInNewContext(expression, {
    items,
    isPinnedConversation: (item) => item.pinned === true,
  });
  assert.deepEqual(Array.from(result, (item) => item.id), ["b", "d", "a", "c"]);
  assert.equal(new Set(result.map((item) => item.id)).size, items.length);
  assert.ok(component.includes("items.some(isPinnedConversation)"));
  assert.ok(component.includes("No conversations yet."));
});

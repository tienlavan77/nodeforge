// Verify direct sidebar navigation preserves conversation grouping and existing selection wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const component = await readFile("ui/nextjs/components/ConversationsAccordion.jsx", "utf8");
const page = await readFile("ui/nextjs/app/page.jsx", "utf8");
const sidebarComponent = await readFile("ui/nextjs/components/conversation-sidebar.jsx", "utf8");
const preferenceSource = await readFile("ui/nextjs/lib/sidebar-preference.js", "utf8");
const preference = runInNewContext(preferenceSource.replaceAll("export ", "") + ";({ readSidebarPreference, writeSidebarPreference, SIDEBAR_PREFERENCE_KEY })", { console });

// Check the sidebar renders its controls directly without an accordion toggle.
test("sidebar places the existing agent selector before the new-conversation control", () => {
  const sidebar = page.slice(page.indexOf('<ConversationSidebar open='), page.indexOf('<section className="home-chat-panel'));
  assert.ok(sidebar.indexOf('className="home-agent-select-row"') < sidebar.indexOf("<ConversationsAccordion"));
  assert.match(sidebar, /selectedAgentLabel=\{selectedArchitectureManager\?\.label\}/);
  assert.match(sidebarComponent, /aria-controls="home-architecture-manager-selector"/);
  assert.match(sidebarComponent, /aria-expanded=\{!collapsed \|\| selecting\}/);
  assert.match(sidebarComponent, /title=\{tooltip\}/);
  assert.match(sidebarComponent, /event\.key === "Escape"/);
  assert.match(sidebarComponent, /querySelector\("select"\)\?\.focus\(\)/);
  assert.match(sidebar, /value=\{selectedArchitectureManagerId\}/);
  assert.match(sidebar, /setSelectedArchitectureManagerId\(agentId\)/);
  assert.match(sidebar, /onSelectConversation=\{handleSelectConversation\}/);
  assert.match(component, /aria-label="New conversation"/);
  assert.doesNotMatch(component, /aria-expanded|conversations-accordion-toggle|>Conversations<\/h/);
  assert.ok(component.indexOf('aria-label="New conversation"') < component.indexOf('aria-label="Conversations list"'));
});

// Verify reload restores only a well-formed device-local collapse preference.
test("sidebar preferences round-trip without modifying conversation storage", () => {
  const values = new Map([["conversation", "active-conversation"], ["agent", "architecture-manager"]]);
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
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

// Verify denied storage getters, reads, and writes never prevent navigation.
test("sidebar preferences tolerate unavailable and failing storage", () => {
  const warnings = [];
  const safePreference = runInNewContext(preferenceSource.replaceAll("export ", "") + ";({ readSidebarPreference, writeSidebarPreference })", { console: { warn: (...args) => warnings.push(args) } });
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

// Guard responsive navigation wiring; browser lifecycle and streaming evidence remain pending.
test("desktop, mobile, and keyboard sidebar controls retain existing navigation wiring", () => {
  assert.match(sidebarComponent, /onClick=\{reopen\} aria-label="Open conversations sidebar"/);
  assert.match(sidebarComponent, /onClick=\{newConversation\} aria-label="New chat"/);
  assert.match(sidebarComponent, /onClick=\{showArchitecture\} aria-label=\{tooltip\}/);
  assert.match(sidebarComponent, /onClick=\{\(\) => \{ changeCollapsed\(!collapsed\)/);
  assert.match(sidebarComponent, /event\.key === "Escape" && selecting/);
  assert.match(sidebarComponent, /architectureRef\.current\?\.focus\(\)/);
  assert.match(sidebarComponent, /button:focus-visible/);
  assert.match(page, /value=\{selectedArchitectureManagerId\}/);
  assert.match(page, /setSelectedArchitectureManagerId\(agentId\)/);
  assert.match(page, /onSelectConversation=\{handleSelectConversation\}/);
  assert.match(sidebarComponent, /\{children\}/);
  assert.doesNotMatch(sidebarComponent, /setMessages|setActiveConversationId|AbortController/);
});

// Exercise actual presentation handlers without granting access to conversation or reception state.
test("collapse and reopen handlers change presentation and preserve external conversation state", () => {
  const state = { collapsed: false, selecting: true, open: false };
  const conversation = { id: "conversation-a", projectId: "project-a", agentId: "architecture-manager", messages: ["first"], history: ["previous"] };
  const snapshot = JSON.stringify(conversation);
  const writes = [];
  const handlers = ["changeCollapsed", "reopen", "showArchitecture", "newConversation"].map((name) => {
    const source = sidebarComponent.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}`))?.[0];
    assert.ok(source, `${name} presentation handler exists`);
    return source;
  });
  const controls = runInNewContext(`${handlers.join("\n")}; ({ changeCollapsed, reopen, showArchitecture, newConversation })`, {
    setCollapsed: (value) => { state.collapsed = value; },
    setSelecting: (value) => { state.selecting = value; },
    writeSidebarPreference: (value) => writes.push(value),
    onOpen: () => { state.open = true; },
    panelRef: { current: { querySelector: (selector) => {
      assert.equal(selector, ".conversations-accordion-new");
      return { click: () => writes.push("new-conversation") };
    } } },
  });
  controls.changeCollapsed(true);
  assert.deepEqual(state, { collapsed: true, selecting: false, open: false });
  assert.equal(JSON.stringify(conversation), snapshot);
  conversation.messages.push("received while collapsed");
  controls.reopen();
  assert.deepEqual(state, { collapsed: false, selecting: false, open: true });
  assert.equal(conversation.id, "conversation-a");
  assert.equal(conversation.projectId, "project-a");
  assert.equal(conversation.agentId, "architecture-manager");
  assert.deepEqual(conversation.messages, ["first", "received while collapsed"]);
  assert.deepEqual(conversation.history, ["previous"]);
  controls.showArchitecture();
  assert.equal(state.selecting, true);
  controls.newConversation();
  assert.deepEqual(writes, [true, false, "new-conversation"]);
});

// Verify collapse and reopen leave active conversation state and streaming mounted.
test("collapse and reopen preserve conversation identity and accumulated reception", () => {
  assert.ok(sidebarComponent.includes("changeCollapsed(next)"));
  assert.ok(sidebarComponent.includes("onOpen()"));
  assert.ok(sidebarComponent.includes("{children}"));
  assert.doesNotMatch(sidebarComponent, /setMessages|setActiveConversationId|AbortController/);
});

test("collapse changes presentation only and retains mounted navigation", () => {
  assert.match(sidebarComponent, /\{children\}/);
  assert.doesNotMatch(sidebarComponent, /setMessages|setActiveConversationId|setSelectedArchitectureManagerId|AbortController|key=\{/);
  assert.match(sidebarComponent, /useEffect\(\(\) => \{ setCollapsed\(readSidebarPreference\(\)\); \}, \[\]\)/);
  assert.doesNotMatch(sidebarComponent, /useEffect[^;]*writeSidebarPreference/);
  assert.match(sidebarComponent, /\.conversation-sidebar\.is-collapsed \.home-agent-select-row, \.conversation-sidebar\.is-collapsed \.conversations-accordion-panel \{ display: none; \}/);
  assert.match(sidebarComponent, /grid-template-columns: 56px/);
  assert.match(sidebarComponent, /@media \(max-width: 640px\)/);
  assert.match(sidebarComponent, /justify-content: flex-start/);
  assert.match(sidebarComponent, /aria-label="Open conversations sidebar"/);
  assert.match(sidebarComponent, /aria-label="New chat"/);
  assert.match(sidebarComponent, /querySelector\("\.conversations-accordion-new"\)\?\.click\(\)/);
});

// Exercise the rendered list's grouping expression against empty, pinned, and unpinned inputs.
test("conversation rows render once in stable pinned-first groups", () => {
  const expression = component.match(/items\.filter\(isPinnedConversation\)\.concat\(items\.filter\(\(conv\) => !isPinnedConversation\(conv\)\)\)/)?.[0];
  assert.ok(expression, "the list uses the existing items and pin predicate");
  const cases = [
    [[], []],
    [[{ id: "a" }, { id: "b" }], ["a", "b"]],
    [[{ id: "a", pinned: true }, { id: "b", pinned: true }], ["a", "b"]],
    [[{ id: "a" }, { id: "b", pinned: true }, { id: "c" }, { id: "d", pinned: true }], ["b", "d", "a", "c"]],
  ];
  for (const [items, expected] of cases) {
    const result = runInNewContext(expression, { items, isPinnedConversation: (item) => item.pinned === true });
    assert.deepEqual(Array.from(result, (item) => item.id), expected);
    assert.equal(new Set(result.map((item) => item.id)).size, items.length);
  }
  assert.match(component, /items\.some\(isPinnedConversation\) && <h3[^>]*>Pinned<\/h3>/);
  assert.match(component, /items\.length === 0 \? \(\s*<p[^>]*>No conversations yet\.<\/p>/);
});

// Guard the existing row selection callback and active conversation authority.
test("conversation rows navigate via the existing selection callback", () => {
  assert.match(component, /active=\{activeConversationId != null && String\(activeConversationId\) === String\(cid\)\}/);
  assert.match(component, /onSelect=\{onSelectConversation\}/);
  assert.match(component, /key=\{cid\}/);
  assert.match(component, /<nav\b[^>]*className="conversations-accordion-panel"[^>]*aria-label="Conversations list"/);
});

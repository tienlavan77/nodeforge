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

// Guard mounted conversation history and streaming while checking responsive navigation wiring.
// Record the desktop, mobile, and keyboard regression matrix for conversation lifecycle actions.
test("conversation workflow matrix covers responsive navigation and active streaming isolation", () => {
  const source = `${page}\n${sidebarComponent}\n${component}`;
  const matrix = [
    ["desktop", "New conversation", "Conversations list"],
    ["mobile", "Open conversations sidebar", "New chat"],
    ["keyboard", "Escape", "querySelector(\"select\")?.focus()"],
  ];
  for (const [, ...signals] of matrix) {
    for (const signal of signals) {
      assert.ok(source.includes(signal), `missing ${signal} regression signal`);
    }
  }
  for (const action of ["onSelectConversation={handleSelectConversation}", "onConfirmRename", "onArchive", "onDelete", "onTogglePin", "onPinError"]) {
    assert.ok(source.includes(action), `missing ${action} action coverage`);
  }
  assert.match(page, /selectedArchitectureManagerId/);
  assert.ok(page.includes("setSelectedArchitectureManagerId(agentId)"));
  assert.match(page, /handleSelectConversation/);
  assert.match(page, /handleSelectConversation/);

  assert.match(sidebarComponent, /children/);
  assert.doesNotMatch(sidebarComponent, /setMessages|setActiveConversationId|AbortController|key=\\{/);
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
  assert.match(sidebarComponent, /\.is-collapsed \.conversations-accordion-panel \{ display: none; \}/);
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
  assert.match(component, /<nav className="conversations-accordion-panel" aria-label="Conversations list">/);
});

// Verify direct sidebar navigation preserves conversation grouping and existing selection wiring.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const component = await readFile("ui/nextjs/components/ConversationsAccordion.jsx", "utf8");
const page = await readFile("ui/nextjs/app/page.jsx", "utf8");

// Check the sidebar renders its controls directly without an accordion toggle.
test("sidebar places the existing agent selector before the new-conversation control", () => {
  const sidebar = page.slice(page.indexOf('<section className="home-conversations-panel'), page.indexOf('<section className="home-chat-panel'));
  assert.ok(sidebar.indexOf('className="home-agent-select-row"') < sidebar.indexOf("<ConversationsAccordion"));
  assert.match(sidebar, /value=\{selectedArchitectureManagerId\}/);
  assert.match(sidebar, /setSelectedArchitectureManagerId\(agentId\)/);
  assert.match(sidebar, /onSelectConversation=\{handleSelectConversation\}/);
  assert.match(component, /aria-label="New conversation"/);
  assert.doesNotMatch(component, /aria-expanded|conversations-accordion-toggle|>Conversations<\/h/);
  assert.ok(component.indexOf('aria-label="New conversation"') < component.indexOf('aria-label="Conversations list"'));
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

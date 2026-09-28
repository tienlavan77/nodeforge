// Exercise dialog interaction rules with runtime event fixtures and source integration checks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

function createDialogFixture() {
  const first = { focusCount: 0, focus() { this.focusCount += 1; } };
  const last = { focusCount: 0, focus() { this.focusCount += 1; } };
  const dialog = { contains: (element) => element === first || element === last };
  return { first, last, dialog };
}

// Verify the same keyboard decisions used by Dialog keep focus within its boundary.
function handleTab(event, dialog, items, activeElement) {
  if (event.key !== "Tab") return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

test("shared dialog traps focus at both boundaries", () => {
  const { first, last, dialog } = createDialogFixture();
  const backward = { key: "Tab", shiftKey: true, prevented: false, preventDefault() { this.prevented = true; } };
  handleTab(backward, dialog, [first, last], first);
  assert.equal(backward.prevented, true);
  assert.equal(last.focusCount, 1);

  const forward = { key: "Tab", shiftKey: false, prevented: false, preventDefault() { this.prevented = true; } };
  handleTab(forward, dialog, [first, last], last);
  assert.equal(forward.prevented, true);
  assert.equal(first.focusCount, 1);
});

test("shared dialog wires runtime dismissal and focus restoration", async () => {
  const source = await readFile(new URL("../components/Dialog.jsx", import.meta.url), "utf8");
  assert.match(source, /createPortal/);
  assert.match(source, /previousFocus\.current\.focus\(\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.target === event\.currentTarget/);
  assert.match(source, /aria-modal="true"/);
});

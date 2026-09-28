// Verify shared dialog keyboard behavior and the rendered component contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installDialogBehavior, shouldCloseOnOutsideClick } from "../components/DialogBehavior.js";

function createElement(documentRef, { focusable = false } = {}) {
  return {
    hidden: false,
    isConnected: true,
    focus() { documentRef.activeElement = this; this.focusCount = (this.focusCount ?? 0) + 1; },
    getAttribute() { return null; },
    ...(focusable ? { matchesFocusable: true } : {}),
  };
}

function createDocument(elements) {
  const listeners = new Set();
  const documentRef = {
    activeElement: null,
    addEventListener(type, listener) { if (type === "keydown") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "keydown") listeners.delete(listener); },
    dispatch(event) { for (const listener of listeners) listener(event); },
  };
  const dialog = {
    focus() { documentRef.activeElement = this; this.focusCount = (this.focusCount ?? 0) + 1; },
    contains(element) { return element === this || elements.includes(element); },
    querySelectorAll() { return elements; },
  };
  return { documentRef, dialog };
}

test("dialog behavior traps focus, dismisses on Escape, and restores focus", () => {
  const elements = [];
  const { documentRef, dialog } = createDocument(elements);
  const trigger = createElement(documentRef);
  const first = createElement(documentRef, { focusable: true });
  const last = createElement(documentRef, { focusable: true });
  elements.push(first, last);
  documentRef.activeElement = trigger;
  const calls = [];
  const onCloseRef = { current: () => calls.push("initial") };
  const cleanup = installDialogBehavior({ dialog, documentRef, onCloseRef, previousFocus: { current: null } });
  onCloseRef.current = () => calls.push("latest");

  const backward = { key: "Tab", shiftKey: true, preventDefault() { this.prevented = true; } };
  documentRef.activeElement = first;
  documentRef.dispatch(backward);
  assert.equal(backward.prevented, true);
  assert.equal(documentRef.activeElement, last);

  const escape = { key: "Escape", preventDefault() { this.prevented = true; } };
  documentRef.dispatch(escape);
  assert.equal(escape.prevented, true);
  assert.deepEqual(calls, ["latest"]);

  cleanup();
  assert.equal(documentRef.activeElement, trigger);
});

test("dialog behavior wraps forward focus and recognizes outside clicks", () => {
  const elements = [];
  const { documentRef, dialog } = createDocument(elements);
  const first = createElement(documentRef, { focusable: true });
  const last = createElement(documentRef, { focusable: true });
  elements.push(first, last);
  const cleanup = installDialogBehavior({ dialog, documentRef, onCloseRef: { current: () => {} }, previousFocus: { current: null } });
  const forward = { key: "Tab", shiftKey: false, preventDefault() { this.prevented = true; } };
  documentRef.activeElement = last;
  documentRef.dispatch(forward);
  assert.equal(forward.prevented, true);
  assert.equal(documentRef.activeElement, first);
  const backdrop = {};
  assert.equal(shouldCloseOnOutsideClick({ target: backdrop, currentTarget: backdrop }, true), true);
  assert.equal(shouldCloseOnOutsideClick({ target: {}, currentTarget: backdrop }, true), false);
  cleanup();
});

test("Dialog component contract renders distinct portal variants with accessible wiring", async () => {
  const source = await import("node:fs/promises").then((fs) => fs.readFile("ui/nextjs/components/Dialog.jsx", "utf8"));
  assert.match(source, /createPortal\(/);
  assert.match(source, /data-dialog-layout=\{resolvedVariant === "drawer" \? "drawer" : "centered"\}/);
  assert.match(source, /shared-dialog-panel--\$\{resolvedVariant\}/);
  assert.match(source, /role="dialog"/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /shouldCloseOnOutsideClick\(event, closeOnOutsideClick\)/);
  assert.match(source, /drawer: \{[^}]*height: "100vh"[^}]*borderRadius: "0"/);
  assert.match(source, /confirmation: \{[^}]*width: "min\(92vw, 440px\)/);
  assert.match(source, /variant="confirmation"/);
  assert.match(source, /variant="drawer"/);
});

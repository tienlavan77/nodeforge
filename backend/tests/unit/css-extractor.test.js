import assert from "node:assert/strict";
import test from "node:test";

import { extractCss } from "../../src/modules/index/parser/css.js";
import { extractorRegistry } from "../../src/modules/index/parser/index.js";

test("extracts CSS class, id, variable, keyframes and at-rule symbols with line ranges", () => {
  const source = `:root {
  --color-primary: #3b82f6;
}

.layout-header {
  display: flex;
}

#project-chat,
.modal.open {
  position: fixed;
}

@keyframes spin-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 768px) {
  .layout-header { display: block; }
}`;

  const extraction = extractorRegistry.extract("ui/globals.css", source);

  assert.deepEqual(extraction.symbols, [
    { name: "--color-primary", kind: "css_variable", start_line: 2, end_line: 2 },
    { name: "layout-header", kind: "css_class", start_line: 5, end_line: 7 },
    { name: "project-chat", kind: "css_id", start_line: 9, end_line: 12 },
    { name: "modal", kind: "css_class", start_line: 9, end_line: 12 },
    { name: "open", kind: "css_class", start_line: 9, end_line: 12 },
    { name: "spin-in", kind: "css_keyframes", start_line: 14, end_line: 17 },
    { name: "@media", kind: "css_at_rule", start_line: 19, end_line: 21 },
    { name: "layout-header", kind: "css_class", start_line: 20, end_line: 20 }
  ]);
  assert.deepEqual(extraction.imports, []);
  assert.deepEqual(extraction.exports, []);
  assert.deepEqual(extraction.calls, []);
});

test("skips element-only selectors and selectors inside comments", () => {
  const source = `/* .commented-out never becomes a symbol */
div,
span:hover,
.button.primary {
  color: red;
}

button { margin: 0; }`;

  const extraction = extractCss(source);

  assert.deepEqual(extraction.symbols, [
    { name: "button", kind: "css_class", start_line: 2, end_line: 6 },
    { name: "primary", kind: "css_class", start_line: 2, end_line: 6 }
  ]);
});

test("survives empty, comment-only and malformed CSS", () => {
  assert.deepEqual(extractCss("").symbols, []);
  assert.deepEqual(extractCss("/* nothing here */\n").symbols, []);
  const malformed = extractCss(".broken { color: red;");
  assert.deepEqual(malformed.symbols, [{ name: "broken", kind: "css_class", start_line: 1, end_line: 1 }]);
});

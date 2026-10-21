// Verifies that documentation does not consume the governed source-code line budget.
import assert from "node:assert/strict";
import test from "node:test";
import { countBudgetLines } from "../../src/tools/agent-code-conventions.js";

test("blank lines and standalone comments do not consume the budget", () => {
  for (const content of ["", "\n \n\t\r\n", "// purpose\n// behavior", "#!/usr/bin/env node\n# purpose", "/* purpose\n * behavior\n */", "<!-- purpose\n behavior\n -->", "/* first */ <!-- second --> // last"]) {
    assert.equal(countBudgetLines(content), 0, JSON.stringify(content));
  }
});

test("mixed lines count once and block terminators resume code on the same physical line", () => {
  assert.equal(countBudgetLines("const first = 1; // reason\n/* purpose\n */ const second = 2;\nconst third = /* reason */ 3;\n<!-- reason --> text\ntext <!-- reason\n --> more"), 6);
  assert.equal(countBudgetLines("/* first */ /* second\n continuation */\n// last\nvalue"), 1);
  assert.equal(countBudgetLines("<!-- first --> <!-- second\n continuation -->\nvalue"), 1);
});

test("ES2022 private fields are code rather than shell comments", () => {
  assert.equal(countBudgetLines("class Account {\n  #privateField;\n  #count = 1;\n}\n# summary\n#!interpreter"), 4);
});

test("quoted comment markers, URLs and regex character classes remain code", () => {
  const content = [
    'const url = "https://example.test/*path*/";',
    "const marker = '<!--';",
    "const pattern = /[/*]/;",
    "const template = `/* text",
    "// still template text",
    "*/`;",
    "const result = 1;"
  ].join("\n");
  assert.equal(countBudgetLines(content), 7);
});

test("regex statements after control-flow parentheses cannot hide subsequent code", () => {
  for (const statement of ["if (ready)", "if (check(value))", "while (ready)", "for (; ready;)", "if /* reason */ (ready)", "if\n(ready)", "if (ready) run(); else", "if (ready) run(); else /* reason */", "if (ready) run(); else\n"]) {
    const content = `${statement} /[/*]/.test(value);\nconst next = 1;\nconst last = 2;`;
    assert.equal(countBudgetLines(content), content.split("\n").length, statement);
  }
  assert.equal(countBudgetLines("if (ready) /[/*]/.test(value);\n/* explanation\n continued */\nconst next = 1;"), 2);
  assert.equal(countBudgetLines("const ratio = calculate(value) / divisor; /* explanation\n continued */\nconst next = 1;"), 2);
  assert.equal(countBudgetLines("if (ready) run(); else /[/*]/.test(value);\n/* explanation\n continued */\nconst next = 1;"), 2);
  assert.equal(countBudgetLines("if (ready) run(); else calculate(value) / divisor; /* explanation\n continued */\nconst next = 1;"), 2);
});

test("CRLF, trailing newlines and comment-only padding preserve the budget boundary", () => {
  const code = Array.from({ length: 250 }, (_, index) => `value${index};`).join("\r\n");
  assert.equal(countBudgetLines(`// purpose\r\n${code}\r\n\r\n/* reason */\r\n`), 250);
  assert.equal(countBudgetLines(`${code}\nnext;\n`), 251);
});

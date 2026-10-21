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

test("regex context survives statement keywords and intervening comments without hiding code", () => {
  for (const statement of [
    "do /[/*]/.test(value); while (ready);",
    "do /* reason */ /[/*]/.test(value); while (ready);",
    "return /* reason */ /[/*]/;",
    "throw /* reason */ /[/*]/;",
    "yield /* reason */ /[/*]/;",
    "const pattern = /* reason */ /[/*]/;",
    "const result = value + /[/*]/.test(input);",
    "const result = value - /[/*]/.test(input);",
    "const result = value * /[/*]/.test(input);",
    "const result = value ** /[/*]/.test(input);",
    "const result = value % /[/*]/.test(input);",
    "const result = value / /[/*]/.test(input);",
    "const result = value + /* reason */ /[/*]/.test(input);",
    "const result = value << /[/*]/.test(input);",
    "const result = value ^ /[/*]/.test(input);",
    "const result = ~ /[/*]/.test(input);"
  ]) {
    assert.equal(countBudgetLines(`${statement}\nconst next = 1;\nconst last = 2;`), 3, statement);
  }
  assert.equal(countBudgetLines("return value /* reason */ / divisor; /* explanation\n continued */\nconst next = 1;"), 2);
  assert.equal(countBudgetLines("do calculate(value) / divisor; while (ready); /* explanation\n continued */\nconst next = 1;"), 2);
  assert.equal(countBudgetLines("return /* reason\n continued */ /[/*]/;\nconst next = 1;"), 3);
  for (const statement of [
    "value++ / divisor;", "value-- / divisor;", "value / divisor;",
    "'value' / divisor;", "\"value\" / divisor;", "`value` / divisor;",
    "/[/*]/ / divisor;", "value + /[/*]/.test(input);"
  ]) {
    assert.equal(countBudgetLines(`${statement} /* explanation\n continued */\nconst next = 1;\nconst last = 2;`), 3, statement);
    assert.equal(countBudgetLines(`${statement} // explanation\n// continued\nconst next = 1;`), 2, statement);
  }
});

// Verifies completed object expressions retain division while statement blocks permit regex statements.
test("object-expression closures preserve division and real multiline comments", () => {
  for (const statement of [
    "const ratio = { class: {} / divisor };",
    "const ratio = { class /* property */: {} / divisor };",
    "const ratio = { class: { class: {} / divisor } / divisor };",
    "const ratio = { class: class {} / divisor };",
    "const ratio = { class: 1, next: {} / divisor };",
    "const ratio = class {} / divisor;",
    "const ratio = class Named {} / divisor;",
    "const ratio = class extends Base {} / divisor;",
    "const ratio = class Named extends mixin({ value: 1 }) { method() { return {}; } } / divisor;",
    "const ratio = class extends (class {}) {} / divisor;",
    "const ratio = class extends class {} {} / divisor;",
    "function calculate() { return class {} / divisor; }",
    ...["void", "typeof", "delete", "await", "new"].map((keyword) => `const ratio = ${keyword} class {} / divisor;`),
    "const ratio = function () {} / divisor;",
    ...["void", "typeof", "delete", "await", "new"].flatMap((keyword) => [
      `const ratio = ${keyword} function () {} / divisor;`,
      `const ratio = ${keyword} /* reason */ function named() {} / divisor;`,
      `const ratio = ${keyword} function* () {} / divisor;`
    ]),
    "const ratio = void async function () {} / divisor;",
    "const ratio = value in function () {} / divisor;",
    "const ratio = value instanceof function () {} / divisor;",
    "switch (value) { case function () {} / divisor: break; }",
    "const ratio = function named() {} / divisor;",
    "const ratio = function* () {} / divisor;",
    "const ratio = async function () {} / divisor;",
    "const ratio = async function* named() {} / divisor;",
    "const ratio = function (value = (() => 1)()) { if (value) { run(); } } / divisor;",
    "const ratio = function () { return function () {}; } / divisor;",
    "function calculate() { return function () {} / divisor; }",
    "const ratio = function /* purpose */ () /* purpose */ {} / divisor;",
    "const ratio = {} / divisor;",
    "const ratio = { value: { nested: 1 } } / divisor;",
    "const ratio = ({ value: 1 }) / divisor;",
    "const values = [{} / divisor];",
    "function calculate() { return { value: 1 } / divisor; }",
    "function calculate() { return /* reason */ {} / divisor; }",
    "if (ready) { const ratio = {} / divisor; }"
  ]) {
    assert.equal(countBudgetLines(`${statement} /* explanation\n continued */\nconst next = 1;`), 2, statement);
  }
  for (const statement of [
    "class Account {} /[/*]/.test(value);",
    "class Account extends Base {} /[/*]/.test(value);",
    "class Account extends mixin({ value: 1 }) { method() { return {}; } } /[/*]/.test(value);",
    "class Account extends (class {}) {} /[/*]/.test(value);",
    "function calculate() {} /[/*]/.test(value);",
    "async function calculate() {} /[/*]/.test(value);",
    "function* calculate() {} /[/*]/.test(value);",
    "if (ready) { run(); } /[/*]/.test(value);",
    "if (ready) { if (next) { run(); } } /[/*]/.test(value);",
    "while (ready) { run(); } /[/*]/.test(value);",
    "if (ready) { run(); } else { run(); } /[/*]/.test(value);",
    "{ const ratio = {}; } /[/*]/.test(value);"
  ]) {
    assert.equal(countBudgetLines(`${statement}\nconst next = 1;\nconst last = 2;`), 3, statement);
  }
});

test("keyword-named properties preserve division and real multiline comments", () => {
  for (const property of ["else", "do", "return", "yield", "throw", "case", "delete", "void", "typeof", "new", "in", "instanceof", "await", "if", "while", "for", "with", "switch", "catch"]) {
    for (const expression of [`account.${property}`, `account?.${property}`, `account. /* reason */ ${property}`, `account.${property}(ready)`]) {
      assert.equal(countBudgetLines(`${expression} / divisor; /* explanation\n continued */\nconst next = 1;`), 2, expression);
      assert.equal(countBudgetLines(`${expression} / divisor; // explanation\n// continued\nconst next = 1;`), 2, expression);
    }
  }
  assert.equal(countBudgetLines("account.\nreturn / divisor; /* explanation\n continued */\nconst next = 1;"), 3);
  assert.equal(countBudgetLines("class Account {\n  #return;\n  read(divisor) {\n    return this.#return / divisor; /* explanation\n continued */\n    const next = 1;\n  }\n}"), 7);
});

test("CRLF, trailing newlines and comment-only padding preserve the budget boundary", () => {
  const code = Array.from({ length: 250 }, (_, index) => `value${index};`).join("\r\n");
  assert.equal(countBudgetLines(`// purpose\r\n${code}\r\n\r\n/* reason */\r\n`), 250);
  assert.equal(countBudgetLines(`${code}\nnext;\n`), 251);
});

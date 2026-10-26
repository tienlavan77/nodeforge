// Exercises the shared lexical attachment rules used by governed new-code checks
// and symbol indexing, including nested declarations and misleading comment text.
import assert from "node:assert/strict";
import test from "node:test";
import { purposeComments, purposeCommentBefore } from "../../src/modules/index/parser/purpose-comments.js";
import { extractFileHeaderComment, extractPrecedingCommentBlock, hasPrecedingComment } from "../../src/tools/agent-code-conventions.js";
import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { extractJavaScript } from "../../src/modules/index/parser/javascript.js";

/** Locates a fixture declaration using its source line rather than hardcoded coordinates. */
function lineOf(source, text) {
  return source.split("\n").findIndex((line) => line.includes(text));
}

test("file headers never satisfy a missing function comment, even without a blank line", () => {
  for (const gap of ["", "\n"]) {
    const source = "#!/usr/bin/env node\n// File contract.\n" + gap + "export function missing() {}";
    assert.equal(extractFileHeaderComment(source), "// File contract.");
    assert.equal(hasPrecedingComment(source, "missing"), false);
  }
  assert.equal(extractFileHeaderComment("#!/usr/bin/env node\nfunction missing() {}"), "");
});

test("adjacent line and block comments attach independently to nested functions", () => {
  const source = "// Module contract.\n\n// Outer contract.\n// @returns value\nexport function outer() {\n  /* Inner contract.\n   * WARNING: preserve order. */\n  function inner() {}\n  function missing() {}\n}";
  const document = purposeComments(source);
  assert.equal(purposeCommentBefore(document, lineOf(source, "export function")).summary, "Outer contract. @returns value");
  assert.equal(purposeCommentBefore(document, lineOf(source, "function inner")).summary, "Inner contract. WARNING: preserve order.");
  assert.equal(hasPrecedingComment(source, "inner"), true);
  assert.equal(hasPrecedingComment(source, "missing"), false);
  assert.equal(extractPrecedingCommentBlock(source, lineOf(source, "function inner")), purposeCommentBefore(document, lineOf(source, "function inner")).raw);
});

test("strings, templates, regex literals and inline implementation comments are excluded", () => {
  const source = '// Header.\nconst text = "\\n// fake";\nconst template = `\n/* fake */\n`;\nconst pattern = /[/*]/;\nconst value = 1; // inline\nfunction missing() {}';
  assert.equal(purposeComments(source).comments.length, 1);
  assert.equal(hasPrecedingComment(source, "missing"), false);
  assert.equal(hasPrecedingComment("/* Header. */\nconst x = 1; /* inline */\nfunction missing() {}", "missing"), false);
});

test("decorators preserve attachment without crossing symbol or implementation boundaries", () => {
  const source = "// Module.\nclass Orders {\n  /** Submit an order. */\n  @audit(\n    { business: 'orders' }\n  )\n  submit() {}\n  missing() {}\n}";
  const document = purposeComments(source);
  assert.equal(extractJavaScript(source).symbols.find((symbol) => symbol.name === "submit").kind, "method");
  assert.equal(purposeCommentBefore(document, lineOf(source, "submit()")).summary, "Submit an order.");
  assert.equal(purposeCommentBefore(document, lineOf(source, "missing()")), null);
});

test("PHP and CSS recognize only their valid standalone comment forms", () => {
  const php = "<?php\n# Module contract.\n\n// Save orders.\nfunction save() {}";
  const document = purposeComments(php, "php");
  assert.equal(document.header.summary, "Module contract.");
  assert.equal(purposeCommentBefore(document, lineOf(php, "function save")).summary, "Save orders.");
  assert.equal(purposeComments('/* Styles. */\n.x { content: "/* fake */"; }', "css").comments.length, 1);
  assert.equal(purposeComments("// invalid CSS\n.x {}", "css").header, null);
});

test("new file header checks retain CSS, PHP and markup compatibility", () => {
  assert.equal(extractFileHeaderComment("/* Styles. */\n.x {}"), "/* Styles. */");
  assert.equal(extractFileHeaderComment("<?php\n/* Orders. */\nfunction save() {}"), "/* Orders. */");
  assert.equal(extractFileHeaderComment("<!-- View. -->\n<main></main>"), "<!-- View. -->");
});

test("PHP multiline strings and attributes cannot masquerade as purpose comments", () => {
  const source = "<?php\n/* Module. */\n$value = <<<'DATA'\n// fake\n/* fake */\nDATA;\n#[Audit]\nfunction missing() {}";
  const document = purposeComments(source, "php");
  assert.equal(document.comments.length, 1);
  assert.equal(purposeCommentBefore(document, lineOf(source, "function missing")), null);
});

test("indexer exposes the same normalized contract for equivalent comment presentations", () => {
  const contents = [];
  for (const comment of ["// Save orders.\n// @returns receipt", "/**\n * Save orders. @returns receipt\n */"]) {
    const source = "// Module.\n\n" + comment + "\nfunction save() {}";
    const symbols = extractJavaScript(source).symbols.map((symbol) => ({ ...symbol, symbol_id: symbol.name }));
    const writer = createIndexRecordWriter({ database: { all: () => symbols, run: (sql, params) => { if (sql.includes("INSERT INTO symbol_content_fts")) contents.push(params[5]); } } });
    writer.indexContent("file", "orders.js", source);
  }
  assert.deepEqual(contents, ["Save orders. @returns receipt\nfunction save() {}", "Save orders. @returns receipt\nfunction save() {}"]);
});

test("indexer and checker attach complete long nested comments to the same symbols", () => {
  const long = Array.from({ length: 100 }, (_, index) => "// contract " + index).join("\n");
  const source = "// Module.\n\n// Outer.\nfunction outer() {\n" + long + "\n  function inner() {}\n  function missing() {}\n}";
  const symbols = extractJavaScript(source).symbols.map((symbol) => ({ ...symbol, symbol_id: symbol.name }));
  const records = [];
  const writer = createIndexRecordWriter({ database: { all: () => symbols, run: (sql, params) => { if (sql.includes("INSERT INTO symbol_content_fts")) records.push(params); } } });
  writer.indexContent("file", "orders.js", source);
  assert.match(records[0][5], /Outer/);
  assert.doesNotMatch(records[0][5], /Module/);
  assert.match(records[1][5], /contract 0/);
  assert.match(records[1][5], /contract 99/);
  assert.doesNotMatch(records[2][5], /contract/);
  assert.equal(hasPrecedingComment(source, "inner"), true);
  assert.equal(hasPrecedingComment(source, "missing"), false);
});

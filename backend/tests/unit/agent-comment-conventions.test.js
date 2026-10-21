// Verifies complete, monolingual purpose summaries for newly introduced files and functions.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { hasFileHeaderComment, hasPrecedingComment, extractPrecedingCommentBlock, validateCommentLanguage } from "../../src/tools/agent-code-conventions.js";
import { createWriteDiffTool, createEditDiffTool } from "../../src/tools/agent-lifecycle-tools.js";

// Supplies observable in-memory writes for convention enforcement without changing project files.
function fixture(initial = "const existing = 1;") {
  let content = initial;
  const fileService = {
    readFile: async () => content,
    atomicWrite: async (input) => { content = input.content; }
  };
  return { fileService, read: () => content, sha256: () => `sha256:${createHash("sha256").update(content).digest("hex")}` };
}

test("file headers and adjacent function summaries recognize complete multiline blocks", () => {
  for (const summary of ["// Business purpose.\n// Technical behavior.", "# Business purpose.\n# Technical behavior.", "/* Business purpose.\n * Technical behavior.\n */", "/** Business purpose.\n * Technical behavior.\n */", "<!-- Business purpose.\n Technical behavior.\n -->"]) {
    const source = `${summary}\nexport function processAccount() {}`;
    assert.equal(hasFileHeaderComment(source), true, summary);
    assert.equal(hasPrecedingComment(source, "processAccount"), true, summary);
    assert.equal(extractPrecedingCommentBlock(source, summary.split("\n").length), summary);
    assert.equal(hasPrecedingComment(`${summary}\n\nfunction processAccount() {}`, "processAccount"), false);
  }
  assert.equal(hasFileHeaderComment("/* unfinished"), false);
  assert.equal(hasFileHeaderComment("<!-- unfinished"), false);
  assert.equal(hasPrecedingComment("const value = 1;\n*/\nfunction processAccount() {}", "processAccount"), false);
  assert.equal(hasPrecedingComment("// Documents the business operation.\nfunction $process() {}", "$process"), true);
});

test("comment language accepts technical tokens and rejects mixed natural-language syntax", () => {
  const vietnamese = "X\u1eed l\u00fd y\u00eau c\u1ea7u an to\u00e0n";
  for (const suffix of ["", " `read_file` API ES2022 countBudgetLines code_lines", " backend/src/tools.js https://example.test", " `the` `returns` `is`", " \"is\" @returns", " isReady() READ_FILE"]) {
    assert.equal(validateCommentLanguage(`${vietnamese}${suffix}`), true, suffix);
  }
  assert.equal(validateCommentLanguage("Returns the account summary with technical identifiers."), true);
  for (const english of ["the", "is", "returns", "checks", "will", "with", "should", "validates"]) {
    assert.equal(validateCommentLanguage(`${vietnamese} ${english} response`), false, english);
  }
  assert.equal(validateCommentLanguage(`// First English sentence.\n// ${vietnamese} returns data.`), false);
});

test("quoted tokens and JSDoc tags preserve monolingual summaries through lifecycle enforcement", async () => {
  for (const summary of ['// X\u1eed l\u00fd token "is" an to\u00e0n.', "// X\u1eed l\u00fd token 'returns' an to\u00e0n.", "/** X\u1eed l\u00fd y\u00eau c\u1ea7u.\n * @returns k\u1ebft qu\u1ea3\n */"]) {
    assert.equal(validateCommentLanguage(summary), true, summary);
    assert.equal(validateCommentLanguage(`${summary}\n// X\u1eed l\u00fd the response.`), false, summary);
    const state = fixture();
    const content = `${summary}\nfunction processAccount() {}`;
    await createEditDiffTool({ fileService: state.fileService }).execute({ path: "existing.js", before_checksum: state.sha256(), anchor: state.read(), replacement: content });
    assert.equal(state.read(), content);
    let written = null;
    const fileService = {
      readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); },
      atomicWrite: async (input) => { written = input.content; }
    };
    await createWriteDiffTool({ fileService }).execute({ path: "new.js", before_checksum: null, content });
    assert.equal(written, content);
  }
});

test("new file mixed summaries fail closed without a write", async () => {
  let writes = 0;
  const fileService = {
    readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); },
    atomicWrite: async () => { writes++; }
  };
  const tool = createWriteDiffTool({ fileService });
  await assert.rejects(() => tool.execute({ path: "new.js", before_checksum: null, content: "/* X\u1eed l\u00fd the response.\n */\nconst value = 1;" }), (error) => error.code === "SUMMARY_REQUIRED" && /one natural language|mixes Vietnamese and English/.test(error.message));
  assert.equal(writes, 0);
  const result = await tool.execute({ path: "new.js", before_checksum: null, content: "/* Processes business requests and validates account state.\n */\nconst value = 1;" });
  assert.equal(writes, 1);
  assert.match(result.content[0].text, /detailed summary.*one natural language/);
});

test("edit_diff validates all lines of new function summaries and preserves legacy comments", async () => {
  const state = fixture("// X\u1eed l\u00fd the legacy response.\nfunction legacy() {}\nconst existing = 1;");
  const tool = createEditDiffTool({ fileService: state.fileService });
  const before = state.read();
  await assert.rejects(() => tool.execute({ path: "existing.js", before_checksum: state.sha256(), anchor: "const existing = 1;", replacement: "/* X\u1eed l\u00fd the response.\n * Validates account state.\n */\nfunction processAccount() {}" }), (error) => error.code === "SUMMARY_REQUIRED" && /mixes Vietnamese and English/.test(error.message));
  assert.equal(state.read(), before);
  const result = await tool.execute({ path: "existing.js", before_checksum: state.sha256(), anchor: "const existing = 1;", replacement: "/* Processes business requests.\n * Validates account state before writing changes.\n */\nfunction processAccount() {}" });
  assert.match(result.reminder, /detailed summary.*one natural language/);
  assert.match(state.read(), /function processAccount/);
});

test("write_diff also checks new functions but does not rewrite existing summaries", async () => {
  const state = fixture("// X\u1eed l\u00fd the legacy response.\nfunction legacy() {}");
  const tool = createWriteDiffTool({ fileService: state.fileService });
  await assert.rejects(() => tool.execute({ path: "existing.js", before_checksum: state.sha256(), content: `${state.read()}\n/* X\u1eed l\u00fd returns data. */\nfunction added() {}` }), (error) => error.code === "SUMMARY_REQUIRED");
  await tool.execute({ path: "existing.js", before_checksum: state.sha256(), content: `${state.read()}\n// Validates account state before fulfilling requests.\nfunction added() {}` });
  assert.match(state.read(), /function added/);
});

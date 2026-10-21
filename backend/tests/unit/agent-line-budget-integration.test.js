// Exercises comment-excluding edit budgets and physical source windows through public Forge tools.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createSedLinesTool } from "../../src/tools/sed-lines.js";
import { createCommittedReviewWindow } from "../../src/modules/supervisor/committed-review-window.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";

// Tracks actual writes and whole-file checksums while simulating existing and absent project files.
function fixture(initial = null) {
  let content = initial;
  let writes = 0;
  const fileService = {
    readFile: async () => {
      if (content === null) throw Object.assign(new Error("Absent"), { code: "ENOENT" });
      return content;
    },
    readForIndex: async () => ({ content }),
    atomicWrite: async (input) => { content = input.content; writes++; }
  };
  return { fileService, read: () => content, writes: () => writes,
    sha256: () => content === null ? null : `sha256:${createHash("sha256").update(content).digest("hex")}` };
}

// Generates a controlled number of business statements with independently variable documentation padding.
function source(codeLines, padding = 0) {
  return "// Documents account processing.\n".repeat(padding + 1) + Array.from({ length: codeLines }, (_, index) => `value${index};`).join("\n");
}

test("write_diff accepts more than 250 physical lines at the 250-code-line boundary for every file type", async () => {
  for (const path of ["account.js", "account.txt", "account.md", "account.html", "account.py"]) {
    const state = fixture();
    const content = source(250, 60);
    const tool = createWriteDiffTool({ fileService: state.fileService });
    await tool.execute({ path, content, before_checksum: null });
    assert.equal(state.read(), content, path);
    await tool.execute({ path, content: `${content}\n// More explanation.`, before_checksum: state.sha256() });
    assert.equal(state.writes(), 2, path);
  }
  const state = fixture();
  const content = `[\n${Array.from({ length: 248 }, () => "0").join(",\n")}\n${"\n".repeat(80)}]`;
  await createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.json", content, before_checksum: null });
  assert.deepEqual(JSON.parse(state.read()), Array(248).fill(0));
});
// Verifies object division at the edit budget boundary without charging multiline comment continuations.
test("object-expression division permits boundary writes and edits with accurate metadata", async () => {
  for (const statement of [
    ...["class {}", "class Named {}", "class extends Base {}", "class extends (class {}) {}",
      "class extends class {} {}", "class Named extends mixin({ value: 1 }) { method() { return {}; } }",
      ...["void", "typeof", "delete", "await", "new"].map((keyword) => `${keyword} class {}`)
    ].map((expression) => `const ratio = ${expression} / divisor;`),
    "class Account {} /[/*]/.test(value);",
    "class Account extends Base {} /[/*]/.test(value);",
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
    "const ratio = function (value = (() => 1)()) { if (value) { run(); } } / divisor;",
    "const ratio = function () { return function () {}; } / divisor;",
    "class Account { class = {} / divisor; /* explanation\n continued */ }", "class Account { static class = {} / divisor; /* explanation\n continued */ }",
    "const ratio = { class: {} / divisor };", "const ratio = { class /* property */: {} / divisor };",
    "const ratio = { class: { class: {} / divisor } / divisor };", "const ratio = { class: class {} / divisor };",
    "const ratio = {} / divisor;",
    "const ratio = { value: { nested: 1 } } / divisor;",
    "const ratio = ({ value: 1 }) / divisor;",
    "function calculate() { return { value: 1 } / divisor; }",
    "if (ready) { run(); } /[/*]/.test(value);"
  ]) {
    const content = `// Documents account processing.\n${statement} /* explanation\n continued */\n${Array.from({ length: 249 - (statement.includes("\n") ? 1 : 0) }, (_, index) => `value${index};`).join("\n")}`;
    const state = fixture();
    const writeTool = createWriteDiffTool({ fileService: state.fileService });
    await writeTool.execute({ path: "account.js", content, before_checksum: null });
    const readTool = createReadFileTool({ fileService: state.fileService });
    const read = await readTool.execute({ path: "account.js", offset: 2, limit: 2 });
    assert.equal(read.code_lines, 250, statement);
    assert.equal(read.total_lines, 252, statement);
    assert.equal(state.read(), content, statement);
    const editTool = createEditDiffTool({ fileService: state.fileService });
    await editTool.execute({ path: "account.js", anchor: "value0;", replacement: "updatedValue;", before_checksum: state.sha256() });
    const edited = content.replace("value0;", "updatedValue;");
    assert.equal(state.read(), edited, statement);
    const metadata = await readTool.execute({ path: "account.js", offset: 2, limit: 2 });
    assert.equal(metadata.code_lines, 250, statement);
    assert.equal(metadata.total_lines, 252, statement);
    await assert.rejects(editTool.execute({ path: "account.js", anchor: "updatedValue;", replacement: "updatedValue;\nextraValue;", before_checksum: state.sha256() }), { code: "CONTENT_TOO_LARGE" });
    await assert.rejects(writeTool.execute({ path: "overflow.js", content: `${edited}\nextraValue;`, before_checksum: null }), { code: "CONTENT_TOO_LARGE" });
    assert.equal(state.read(), edited, statement);
    assert.equal(state.writes(), 2, statement);
  }
});

test("keyword property division permits boundary writes and edits with accurate metadata", async () => {
  for (const expression of ["account.return", "account?.throw", "account. /* reason */ do", "account.await", "account.in", "account.if(ready)"]) {
    const content = `// Documents account processing.\n${expression} / divisor; /* explanation\n continued */\n${Array.from({ length: 249 }, (_, index) => `value${index};`).join("\n")}`;
    const state = fixture();
    await createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.js", content, before_checksum: null });
    assert.equal(state.read(), content, expression);
    const readTool = createReadFileTool({ fileService: state.fileService });
    const read = await readTool.execute({ path: "account.js", offset: 1, limit: 2 });
    assert.equal(read.code_lines, 250, expression);
    assert.equal(read.total_lines, 252, expression);
    await createEditDiffTool({ fileService: state.fileService }).execute({ path: "account.js", anchor: "divisor;", replacement: "otherDivisor;", before_checksum: state.sha256() });
    assert.equal(state.read(), content.replace("divisor;", "otherDivisor;"), expression);
    assert.equal(state.writes(), 2, expression);
    const edited = await readTool.execute({ path: "account.js", offset: 1, limit: 2 });
    assert.equal(edited.code_lines, 250, expression);
    assert.equal(edited.total_lines, 252, expression);
  }
});

// Verifies private-property division preserves compliant lifecycle writes, edits, and metadata.
test("private-property division permits valid class boundary writes and edits", async () => {
  const content = `// Processes account values within the private-field boundary.\nclass Account {\n  #return;\n  read(divisor) {\n    return this.#return / divisor; /* explanation\n continued */\n    const next = 1;\n  }\n}\n${Array.from({ length: 243 }, (_, index) => `value${index};`).join("\n")}`;
  const state = fixture();
  await createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.js", content, before_checksum: null });
  const readTool = createReadFileTool({ fileService: state.fileService });
  const read = await readTool.execute({ path: "account.js", offset: 1, limit: 2 });
  assert.equal(read.code_lines, 250);
  assert.equal(read.total_lines, 252);
  await createEditDiffTool({ fileService: state.fileService }).execute({ path: "account.js", anchor: "divisor;", replacement: "otherDivisor;", before_checksum: state.sha256() });
  assert.equal(state.read(), content.replace("divisor;", "otherDivisor;"));
  assert.equal((await readTool.execute({ path: "account.js", offset: 1, limit: 2 })).code_lines, 250);
});

test("write_diff rejects code overflow with legacy and new diagnostic fields and performs no write", async () => {
  const state = fixture();
  await assert.rejects(() => createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.js", content: source(251, 60), before_checksum: null }), (error) => {
    assert.equal(error.code, "CONTENT_TOO_LARGE");
    assert.deepEqual(error.details, { line_count: 312, code_lines: 251, total_lines: 312, limit: 250 });
    return true;
  });
  assert.equal(state.writes(), 0);
});

test("regex statements cannot bypass write or edit overflow protection or read metadata", async () => {
  for (const statement of [
    "if (ready) /[/*]/.test(value);",
    "if (ready) run(); else /[/*]/.test(value);",
    "if (ready) run(); else /* reason */ /[/*]/.test(value);",
    "do /[/*]/.test(value); while (ready);",
    "do /* reason */ /[/*]/.test(value); while (ready);",
    "const pattern = (() => { return /* reason */ /[/*]/; })();",
    "const result = value + /[/*]/.test(input);",
    "const result = value - /[/*]/.test(input);",
    "const result = value * /[/*]/.test(input);",
    "const result = value ** /[/*]/.test(input);",
    "const result = value % /[/*]/.test(input);",
    "const result = value / /[/*]/.test(input);",
    "const result = value + /* reason */ /[/*]/.test(input);"
  ]) {
    const content = `// Documents account processing.\n${statement}\n${Array.from({ length: 249 }, (_, index) => `value${index};`).join("\n")}`;
    const state = fixture(content);
    const read = await createReadFileTool({ fileService: state.fileService }).execute({ path: "account.js", offset: 1, limit: 2 });
    assert.equal(read.code_lines, 250);
    assert.equal(read.total_lines, 251);
    await assert.rejects(() => createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.js", content: `${content}\nnext;`, before_checksum: state.sha256() }), (error) => {
      assert.equal(error.code, "CONTENT_TOO_LARGE");
      assert.equal(error.details.code_lines, 251);
      return true;
    });
    await assert.rejects(() => createEditDiffTool({ fileService: state.fileService }).execute({ path: "account.js", anchor: "value248;", replacement: "value248;\nnext;", before_checksum: state.sha256() }), (error) => {
      assert.equal(error.code, "CONTENT_TOO_LARGE");
      assert.equal(error.details.code_lines, 251);
      return true;
    });
    assert.equal(state.read(), content);
    assert.equal(state.writes(), 0);
  }
});

test("destructive overwrite measures existing code, preserves diagnostics and permits localized oversized edits", async () => {
  const state = fixture(source(260, 40));
  await assert.rejects(() => createWriteDiffTool({ fileService: state.fileService }).execute({ path: "account.js", content: source(1), before_checksum: state.sha256() }), (error) => {
    assert.equal(error.code, "DESTRUCTIVE_OVERWRITE");
    assert.equal(error.details.current_lines, 301);
    assert.equal(error.details.total_lines, 301);
    assert.equal(error.details.code_lines, 260);
    return true;
  });
  assert.equal(state.writes(), 0);
  const edit = createEditDiffTool({ fileService: state.fileService });
  await edit.execute({ path: "account.js", before_checksum: state.sha256(), anchor: "value0;", replacement: "updatedValue;" });
  await edit.execute({ path: "account.js", before_checksum: state.sha256(), anchor: "value1;", replacement: "// Explains removed work." });
  assert.equal(state.writes(), 2);
  await assert.rejects(() => edit.execute({ path: "account.js", before_checksum: state.sha256(), anchor: "updatedValue;", replacement: "updatedValue;\nextra;" }), { code: "CONTENT_TOO_LARGE" });
  assert.equal(state.writes(), 2);
});

test("edit_diff permits comment padding but rejects growth across the code-line limit", async () => {
  const state = fixture(source(250, 50));
  const edit = createEditDiffTool({ fileService: state.fileService });
  await edit.execute({ path: "account.js", before_checksum: state.sha256(), anchor: "value0;", replacement: `${"// Detailed explanation.\n".repeat(100)}value0;` });
  const before = state.read();
  await assert.rejects(() => edit.execute({ path: "account.js", before_checksum: state.sha256(), anchor: "value0;", replacement: "value0;\nadded;" }), (error) => error.code === "CONTENT_TOO_LARGE" && error.details.code_lines === 251 && error.details.total_lines === 402 && error.details.line_count === 402);
  assert.equal(state.read(), before);
  await assert.rejects(() => edit.execute({ path: "account.js", before_checksum: "sha256:" + "0".repeat(64), anchor: "value0;", replacement: "changed;" }), { code: "CHECKSUM_MISMATCH" });
  await assert.rejects(() => edit.execute({ path: "outside.js", before_checksum: state.sha256(), anchor: "value0;", replacement: "changed;" }, { allowed_file_paths: ["account.js"] }), { code: "PATH_FORBIDDEN" });
});

test("read_file and committed windows retain physical addresses and the 80-line cap", async () => {
  const state = fixture(source(2, 300) + "\n");
  const read = createReadFileTool({ fileService: state.fileService });
  const metadata = await read.execute({ path: "account.js" });
  assert.equal(metadata.total_lines, 304);
  assert.equal(metadata.code_lines, 2);
  const window = await read.execute({ path: "account.js", offset: 302, limit: 2 });
  assert.equal(window.content, "value0;\nvalue1;");
  assert.equal(window.sha256, state.sha256());
  assert.equal(window.total_lines, 304);
  assert.equal(window.code_lines, 2);
  await assert.rejects(() => read.execute({ path: "account.js", offset: 1, limit: 81 }), { code: "INPUT_INVALID" });
  const committed = createCommittedReviewWindow(state.fileService, "read_lines");
  const context = { task_id: "budget-test", capabilities: ["read_lines"], allowed_file_paths: ["account.js"] };
  const result = await committed.execute({ path: "account.js", start_line: 302, end_line: 303 }, context);
  assert.equal(result.stdout, "value0;\nvalue1;\n");
  assert.equal(result.total_lines, 304);
  assert.equal(result.code_lines, 2);
  await assert.rejects(() => committed.execute({ path: "account.js", start_line: 1, end_line: 81 }, context), { code: "READ_LINES_INPUT_INVALID" });
});

test("sed_lines returns the whole-file code budget without renumbering its physical window", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-budget-"));
  try {
    const fileService = createFileService({ projectRoot: root });
    await fileService.atomicWrite({ path: "account.js", content: source(2, 300) + "\n", replace: true });
    const tool = createSedLinesTool({ projectRoot: root, fileService, logger: { emit() {} } });
    const context = { task_id: "budget-test", capabilities: ["sed_lines"], allowed_file_paths: ["account.js"] };
    const result = await tool.execute({ path: "account.js", start_line: 302, end_line: 303 }, context);
    assert.equal(result.stdout, "value0;\nvalue1;\n");
    assert.equal(result.total_lines, 304);
    assert.equal(result.code_lines, 2);
    assert.match(result.sha256, /^sha256:[a-f0-9]{64}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

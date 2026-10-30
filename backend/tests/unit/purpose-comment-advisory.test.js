/**
 * Protects the advisory boundary of purpose-comment lengths with real lifecycle
 * tool writes. Normalized counts are technical whitespace units; existing presence
 * and language gates still reject invalid new comments without touching legacy prose.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { countPurposeCommentWords, PURPOSE_COMMENT_GUIDANCE } from "../../src/shared/purpose-comment-guidance.js";
import { createWriteDiffTool, createEditDiffTool } from "../../src/tools/governance/agent-lifecycle-tools.js";

test("word counts exclude wrappers, decorative prefixes and empty whitespace units", () => {
  for (const raw of ["// One two\n// three", "# One two\n# three", "/* One two\n * three\n */", "/** One\t two\r\n * three */", "<!-- One two\n three -->"]) {
    assert.equal(countPurposeCommentWords(raw), 3, raw);
  }
  assert.equal(countPurposeCommentWords("/* \n * \n */"), 0);
  assert.equal(countPurposeCommentWords(), 0);
  assert.equal(countPurposeCommentWords("// Xử lý yêu cầu"), 4);
  assert.equal(countPurposeCommentWords("// API `read_file` @returns result."), 4);
});

test("new file writes accept short and long comments and return advisory guidance", async () => {
  for (const summary of ["Processes requests.", "Explains ".repeat(200)]) {
    let written;
    const fileService = {
      readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); },
      atomicWrite: async (input) => { written = input.content; }
    };
    const content = `// ${summary}\nconst value = 1;`;
    const result = await createWriteDiffTool({ fileService }).execute({ path: "new.js", before_checksum: null, content });
    assert.equal(written, content);
    assert.ok(result.content[0].text.includes(PURPOSE_COMMENT_GUIDANCE));
  }
});

test("new functions accept advisory lengths while preserving historical comments", async () => {
  for (const summary of ["Processes requests.", "Explains ".repeat(200)]) {
    let content = "// Xử lý the legacy response.\nfunction legacy() {}\nconst existing = 1;";
    const before = content;
    const fileService = { readFile: async () => content, atomicWrite: async (input) => { content = input.content; } };
    const replacement = `${before}\n// ${summary}\nfunction processRequest() {}`;
    const result = await createEditDiffTool({ fileService }).execute({
      path: "existing.js", before_checksum: `sha256:${createHash("sha256").update(before).digest("hex")}`,
      anchor: before, replacement
    });
    assert.equal(content, replacement);
    assert.ok(content.startsWith(before));
    assert.ok(result.reminder.includes(PURPOSE_COMMENT_GUIDANCE));
  }
});

test("missing and mixed comments still fail before any new-file write", async () => {
  let writes = 0;
  const fileService = {
    readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); },
    atomicWrite: async () => { writes++; }
  };
  for (const content of ["const value = 1;", "// Xử lý the response.\nconst value = 1;"]) {
    await assert.rejects(() => createWriteDiffTool({ fileService }).execute({
      path: "new.js", before_checksum: null, content
    }), { code: "SUMMARY_REQUIRED" });
  }
  assert.equal(writes, 0);
});

test("consistent Vietnamese prose with technical identifiers remains accepted", async () => {
  let written;
  const fileService = {
    readFile: async () => { throw Object.assign(new Error("Absent"), { code: "ENOENT" }); },
    atomicWrite: async (input) => { written = input.content; }
  };
  const content = "// Xử lý yêu cầu `read_file` API.\nconst value = 1;";
  await createWriteDiffTool({ fileService }).execute({ path: "new.js", before_checksum: null, content });
  assert.equal(written, content);
});

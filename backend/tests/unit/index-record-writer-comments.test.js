// Verifies complete symbol comments reach search and asynchronous embeddings without unrelated text.
import assert from "node:assert/strict";
import test from "node:test";

import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { checksumEmbeddingText } from "../../src/modules/index/embedding-job-store.js";

// Captures indexing writes and embedding requests while preserving the writer's asynchronous behavior.
function createFixture(symbols, { queued = false } = {}) {
  const records = [];
  const embeddings = [];
  const jobs = [];
  const stored = [];
  const database = {
    // Supplies extracted symbols and an empty embedding cache for indexing tests.
    all(sql) { return sql.includes("FROM symbols") ? symbols : []; },
    // Records searchable content so tests can assert the persisted symbol text.
    run(sql, params) { records.push({ sql, params }); }
  };
  const writer = createIndexRecordWriter({
    database,
    embeddingModel: "existing-model",
    embeddingProvider: {
      // Captures provider text to verify complete comments and the existing length limit.
      async embed(text) { embeddings.push(text); return [1, 0]; }
    },
    embeddingStore: {
      // Captures completed embeddings without changing the persistence contract.
      upsert(record) { stored.push(record); }
    },
    embeddingJobs: queued ? {
      // Records deferred embedding jobs for checksum and scheduling assertions.
      enqueue(job) { jobs.push(job); }
    } : undefined,
    logger: console
  });
  return { writer, records, embeddings, jobs, stored };
}

// Builds extraction records with the same one-based line boundaries used by indexing.
function symbolAt(start, end = start, name = "target") {
  return { symbol_id: `SYM-${name}`, name, kind: "function", start_line: start, end_line: end };
}

// Selects full-text symbol content independently of file-content writes.
function symbolContents(fixture) {
  return fixture.records.filter(({ sql }) => sql.startsWith("INSERT INTO symbol_content_fts"))
    .map(({ params }) => params[5]);
}

for (const [kind, comments] of [
  ["slash", ["// first", "// second", "// third", "// fourth", "// fifth"]],
  ["hash", ["# first", "# second", "# third", "# fourth", "# fifth"]],
  ["block", ["/*", "Business purpose", "", "More detail", " * Final detail", " */"]],
  ["html", ["<!--", "Business purpose", "", "More detail", "Final detail", "-->"]],
  ["mixed", ["// first", "/* second */", "<!-- third -->", "# fourth", "// fifth"]]
]) {
  test(`indexes the complete adjacent ${kind} comment block`, async () => {
    const content = [...comments, "function target() {}"].join("\n");
    const fixture = createFixture([symbolAt(comments.length + 1)]);
    fixture.writer.indexContent("FILE", "example.js", content);
    assert.deepEqual(symbolContents(fixture), [content]);
    assert.deepEqual(fixture.embeddings, [`target [function]\n${content}`]);
    await Promise.resolve();
    assert.equal(fixture.stored.length, 1);
    assert.equal(fixture.stored[0].model, "existing-model");
    assert.equal(fixture.stored[0].checksum, checksumEmbeddingText(`target\nfunction\n${content}`));
  });
}

for (const header of ["// File header", "# File header", "/* File header */", "<!-- File header -->"]) {
  test(`does not attach a separated ${header} to an undocumented symbol`, () => {
    const fixture = createFixture([symbolAt(3)]);
    fixture.writer.indexContent("FILE", "example.js", `${header}\n\nfunction target() {}`);
    assert.deepEqual(symbolContents(fixture), ["function target() {}"]);
  });
}

test("stops at intervening code and preserves only the symbol's own comments", () => {
  const fixture = createFixture([symbolAt(5)]);
  fixture.writer.indexContent("FILE", "example.js", [
    "// File header", "const setting = true;", "// Own purpose", "// Own detail", "function target() {}"
  ].join("\n"));
  assert.deepEqual(symbolContents(fixture), ["// Own purpose\n// Own detail\nfunction target() {}"]);
});

test("does not scan comments inside a previous symbol", () => {
  const content = ["function previous() {", "// previous content", "// previous ending", "function target() {}"].join("\n");
  const fixture = createFixture([symbolAt(1, 3, "previous"), symbolAt(4)]);
  fixture.writer.indexContent("FILE", "example.js", content);
  assert.deepEqual(symbolContents(fixture), [content.split("\n").slice(0, 3).join("\n"), "function target() {}"]);
});

test("does not collect a partial block across the previous symbol boundary", () => {
  const fixture = createFixture([symbolAt(1, 2, "previous"), symbolAt(5)]);
  fixture.writer.indexContent("FILE", "example.js", "/* previous\nbody\ncontinued\n*/\nfunction target() {}");
  assert.equal(symbolContents(fixture)[1], "function target() {}");
});

test("does not attach a trailing block comment belonging to intervening code", () => {
  const fixture = createFixture([symbolAt(2)]);
  fixture.writer.indexContent("FILE", "example.js", "const setting = true; /* not documentation */\nfunction target() {}");
  assert.deepEqual(symbolContents(fixture), ["function target() {}"]);
});

test("preserves full search content while keeping the provider's 4000-character contract", () => {
  const content = `${Array.from({ length: 80 }, () => `// ${"detail ".repeat(12)}`).join("\n")}\nfunction target() {}`;
  const fixture = createFixture([symbolAt(81)]);
  fixture.writer.indexContent("FILE", "example.js", content);
  assert.deepEqual(symbolContents(fixture), [content]);
  assert.equal(fixture.embeddings[0].length, 4000);
  assert.equal(fixture.embeddings[0], `target [function]\n${content}`.slice(0, 4000));
});

test("queues embeddings asynchronously with a checksum covering the complete comment", async () => {
  const content = "// first\n// second\n// third\n// fourth\n// fifth\nfunction target() {}";
  const fixture = createFixture([symbolAt(6)], { queued: true });
  fixture.writer.indexContent("FILE", "example.js", content);
  assert.equal(fixture.jobs.length, 0);
  await Promise.resolve();
  assert.deepEqual(fixture.jobs, [{
    symbolId: "SYM-target",
    contentChecksum: checksumEmbeddingText(`target\nfunction\n${content}`),
    model: "existing-model"
  }]);
  assert.deepEqual(symbolContents(fixture), [content]);
  assert.deepEqual(fixture.embeddings, []);
});

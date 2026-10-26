// Verifies complete symbol comments reach search and asynchronous embeddings without unrelated text.
import assert from "node:assert/strict";
import test from "node:test";

import { createIndexRecordWriter } from "../../src/modules/index/index-record-writer.js";
import { purposeSummaryInput } from "../../src/modules/index/purpose-summary-input.js";

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

for (const [path, comments, summary] of [
  ["example.js", ["// first", "// second", "// third", "// fourth", "// fifth"], "first second third fourth fifth"],
  ["example.php", ["# first", "# second", "# third", "# fourth", "# fifth"], "first second third fourth fifth"],
  ["example.js", ["/*", "Business purpose", "", "More detail", " * Final detail", " */"], "Business purpose More detail Final detail"]
]) {
  test(`indexes the complete normalized adjacent comment for ${path}`, async () => {
    const prefix = path.endsWith(".php") ? "<?php\n/* File header */\n\n" : "// File header\n\n";
    const content = prefix + [...comments, "function target() {}"].join("\n");
    const fixture = createFixture([symbolAt(content.split("\n").length)]);
    fixture.writer.indexContent("FILE", path, content);
    const expected = summary + "\nfunction target() {}";
    assert.deepEqual(symbolContents(fixture), [expected]);
    assert.deepEqual(fixture.embeddings, [expected.split("\n")[0]]);
    await Promise.resolve();
    assert.equal(fixture.stored.length, 1);
    assert.equal(fixture.stored[0].model, "existing-model");
    assert.equal(fixture.stored[0].checksum, purposeSummaryInput(expected.split("\n")[0]).checksum);
  });
}

for (const [path, prefix, header] of [
  ["example.js", "", "// File header"],
  ["example.js", "", "/* File header */"],
  ["example.php", "<?php\n", "# File header"],
  ["example.php", "<?php\n", "/* File header */"]
]) {
  for (const gap of ["\n", "\n\n", "\n\n\n"]) {
    test(`never attaches a file header to an undocumented symbol: ${path} ${header} ${gap.length}`, () => {
      const content = prefix + header + gap + "function target() {}";
      const fixture = createFixture([symbolAt(content.split("\n").length)]);
      fixture.writer.indexContent("FILE", path, content);
      assert.deepEqual(symbolContents(fixture), ["function target() {}"]);
      assert.deepEqual(fixture.embeddings, []);
    });
  }
}

test("stops at intervening code and preserves only the symbol's own comments", () => {
  const fixture = createFixture([symbolAt(5)]);
  fixture.writer.indexContent("FILE", "example.js", [
    "// File header", "const setting = true;", "// Own purpose", "// Own detail", "function target() {}"
  ].join("\n"));
  assert.deepEqual(symbolContents(fixture), ["Own purpose Own detail\nfunction target() {}"]);
});

test("does not scan comments inside a completed previous symbol", () => {
  const lines = ["function previous() {", "// previous content", "// previous ending", "}", "function target() {}"];
  const fixture = createFixture([symbolAt(1, 4, "previous"), symbolAt(5)]);
  fixture.writer.indexContent("FILE", "example.js", lines.join("\n"));
  assert.deepEqual(symbolContents(fixture), [lines.slice(0, 4).join("\n"), "function target() {}"]);
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

test("preserves full normalized search content and complete provider summary", () => {
  const content = "// Module.\n\n" + Array.from({ length: 80 }, () => "// " + "detail ".repeat(12)).join("\n") + "\nfunction target() {}";
  const expected = Array.from({ length: 960 }, () => "detail").join(" ") + "\nfunction target() {}";
  const fixture = createFixture([symbolAt(83)]);
  fixture.writer.indexContent("FILE", "example.js", content);
  assert.deepEqual(symbolContents(fixture), [expected]);
  assert.ok(fixture.embeddings[0].length > 4000);
  assert.equal(fixture.embeddings[0], expected.split("\n")[0]);
});

for (const code of ["const pattern = /a*/", "const pattern = /a*/;", "const text = '*/'", "const text = '-->'"]) {
  test(`does not treat executable delimiter text as documentation: ${code}`, () => {
    const fixture = createFixture([symbolAt(3)]);
    fixture.writer.indexContent("FILE", "example.js", `/* File header */\n${code}\nfunction target() {}`);
    assert.deepEqual(symbolContents(fixture), ["function target() {}"]);
    assert.deepEqual(fixture.embeddings, []);
  });
}

for (const [comments, summary] of [
  [["/*", " * Explain /* syntax", " */"], "Explain /* syntax"],
  [["/*", "/* is literal comment prose", " */"], "/* is literal comment prose"]
]) {
  test(`preserves literal opening delimiters inside ${summary} documentation`, () => {
    const content = ["// Module.", "", ...comments, "function target() {}"].join("\n");
    const fixture = createFixture([symbolAt(comments.length + 3)]);
    fixture.writer.indexContent("FILE", "example.js", content);
    const expected = summary + "\nfunction target() {}";
    assert.deepEqual(symbolContents(fixture), [expected]);
    assert.deepEqual(fixture.embeddings, [expected.split("\n")[0]]);
  });
}

for (const adjacency of [[], [""], ["", ""]]) {
  test(`shares whitespace adjacency rules with the checker across ${adjacency.length} blanks`, () => {
    const body = ["function target() {", "  return true;", "}"];
    const lines = ["const setting = true;", "// Own purpose", "// Own detail", ...adjacency, ...body];
    const start = lines.length - body.length + 1;
    const fixture = createFixture([symbolAt(start, lines.length)]);
    fixture.writer.indexContent("FILE", "example.js", lines.join("\n"));
    const expected = ["Own purpose Own detail", ...body].join("\n");
    assert.deepEqual(symbolContents(fixture), [expected]);
    assert.deepEqual(fixture.embeddings, [expected.split("\n")[0]]);
    const record = fixture.records.find(({ sql }) => sql.startsWith("INSERT INTO symbol_content_fts"));
    assert.deepEqual(record.params.slice(6), [start, lines.length]);
  });
}

test("keeps comments bounded by a previous decorated symbol", () => {
  const lines = ["class Orders {", "@cached", "previous() {", "// Previous purpose", "}", "// Own purpose", "@cached", "target() {}", "}"];
  const fixture = createFixture([symbolAt(2, 5, "previous"), symbolAt(8)]);
  fixture.writer.indexContent("FILE", "example.js", lines.join("\n"));
  const expected = "Own purpose\ntarget() {}";
  assert.equal(symbolContents(fixture)[1], expected);
  assert.equal(fixture.embeddings[0], "Own purpose");
});

test("queues embeddings asynchronously with a checksum covering the complete normalized comment", async () => {
  const content = "// Module.\n\n// first\n// second\n// third\n// fourth\n// fifth\nfunction target() {}";
  const expected = "first second third fourth fifth\nfunction target() {}";
  const fixture = createFixture([symbolAt(8)], { queued: true });
  fixture.writer.indexContent("FILE", "example.js", content);
  assert.equal(fixture.jobs.length, 0);
  await Promise.resolve();
  assert.deepEqual(fixture.jobs, [{
    symbolId: "SYM-target",
    contentChecksum: purposeSummaryInput(expected.split("\n")[0]).checksum,
    model: "existing-model"
  }]);
  assert.deepEqual(symbolContents(fixture), [expected]);
  assert.deepEqual(fixture.embeddings, []);
});

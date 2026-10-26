// Verifies that purpose summaries retain complete business contracts while ignoring
// comment wrappers and presentation whitespace across supported source formats.
import assert from "node:assert/strict";
import test from "node:test";
import { normalizePurposeComment, purposeComments } from "../../src/modules/index/parser/purpose-comments.js";

test("equivalent wrappers, indentation and line endings produce identical summaries", () => {
  const expected = "Deliver orders. @returns receipt WARNING: never retry twice.";
  for (const raw of [
    "// Deliver orders.\n// @returns receipt\n// WARNING: never retry twice.",
    "/* Deliver orders. @returns receipt WARNING: never retry twice. */",
    "/**\r\n * Deliver orders.\r\n * @returns receipt\r\n * WARNING: never retry twice.\r\n */",
    "# Deliver orders.\n# @returns receipt\n# WARNING: never retry twice."
  ]) assert.equal(normalizePurposeComment(raw), expected);
});

test("wrapping does not lose contract tags, warnings, punctuation or order", () => {
  const raw = "/* Save all records.\n * @param id required\n * @throws Failure\n * WARNING: no retry! */";
  const summary = normalizePurposeComment(raw);
  assert.equal(summary, "Save all records. @param id required @throws Failure WARNING: no retry!");
  assert.notEqual(normalizePurposeComment(raw.replace("required", "optional")), summary);
  assert.notEqual(normalizePurposeComment(raw.replace("@throws Failure", "@throws Timeout")), summary);
  assert.notEqual(normalizePurposeComment("/* b a */"), normalizePurposeComment("/* a b */"));
});

// Protects literal delimiter contracts from colliding with summaries that omit those words.
test("only the detected outer wrapper loses its closing delimiter", () => {
  for (const delimiter of ["*/", "-->"]) {
    for (const prefix of ["//", "#"]) {
      const raw = prefix + " Emit literal " + delimiter;
      assert.equal(normalizePurposeComment(raw), "Emit literal " + delimiter);
      assert.notEqual(normalizePurposeComment(raw), normalizePurposeComment(prefix + " Emit literal"));
    }
    assert.equal(purposeComments("// Emit literal " + delimiter + "\nconst value = 1;").header.summary,
      "Emit literal " + delimiter);
  }
  assert.equal(normalizePurposeComment("/* Emit literal --> */"), "Emit literal -->");
  assert.equal(normalizePurposeComment("<!-- Emit literal */ -->"), "Emit literal */");
  assert.equal(normalizePurposeComment("/* <!-- Emit literal --> */"), "<!-- Emit literal -->");
  assert.equal(normalizePurposeComment("// First line\r\n// Emit literal */\r\n"), "First line Emit literal */");
});

test("long summaries preserve their final contract rather than truncating", () => {
  const body = Array.from({ length: 600 }, (_, index) => "contract" + index).join(" ");
  assert.equal(normalizePurposeComment("/* " + body + " @returns final */"), body + " @returns final");
  assert.equal(purposeComments("// " + body + "\nconst value = 1;").header.summary, body);
});

// Verifies the existing service palette and requested result colors without
// ANSI contamination of saved logs or hiding outcomes in narrow viewports.
import assert from "node:assert/strict";
import test from "node:test";
import { createForegroundLogReceiver, formatForegroundLine } from "../../scripts/dev-foreground-line.mjs";

test("source colors remain API cyan, UI green and WATCHER magenta", () => {
  for (const [name, color] of [["api", "36"], ["ui", "32"], ["watcher", "35"]]) {
    const line = formatForegroundLine({ name, line: "[13:00:00] [Node] Result - SUCCESS" });
    assert.ok(line.startsWith(`\x1b[${color}m[${name.toUpperCase()}]\x1b[0m`));
    assert.ok(line.endsWith(" - \x1b[32mSUCCESS\x1b[0m"));
  }
});

test("result colors apply only to the final token and not message contents", () => {
  for (const [result, color] of [["SUCCESS", "32"], ["FAIL", "31"], ["WAIT", "33"], ["RETRY", "33"]]) {
    const content = `[13:00:00] [Coder/Nobe] Text includes OK and FAIL - ${result}`;
    const line = formatForegroundLine({ name: "api", line: content });
    assert.ok(line.includes("Text includes OK and FAIL"));
    assert.ok(line.endsWith(` - \x1b[${color}m${result}\x1b[0m`));
    assert.equal(formatForegroundLine({ name: "api", line: content }, { color: false }), `[API] ${content}`);
  }
});

test("clipping retains the colored result and copied logs contain no ANSI", () => {
  const entry = { name: "api", line: `[13:00:00] [Coder/Nobe] ${"long ".repeat(100)} - FAIL` };
  const plain = formatForegroundLine(entry, { width: 80, color: false });
  assert.equal(plain.length, 80);
  assert.ok(plain.endsWith("… - FAIL"));
  assert.ok(formatForegroundLine(entry, { width: 80 }).endsWith("… - \x1b[31mFAIL\x1b[0m"));
  const saved = formatForegroundLine(entry, { color: false });
  assert.ok(saved.includes(entry.line));
  assert.ok(!saved.includes(String.fromCharCode(27)));
});

test("split UTF-8 chunks and status suffixes are reassembled as one logical result", () => {
  const lines = [], receive = createForegroundLogReceiver((line) => lines.push(line));
  const text = "[13:00:00] [SE/Cú đêm] read_file - SUCCESS\nnext result - FAIL";
  const bytes = Buffer.from(text);
  for (const byte of bytes) receive(Buffer.from([byte]));
  assert.equal(lines.length, 1);
  receive.finish();
  assert.deepEqual(lines, text.split("\n"));
});

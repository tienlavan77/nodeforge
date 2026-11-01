// Verifies terminal mouse input copies the exact frozen log selection over SSH
// without leaking mouse coordinates into commands or copying ANSI styling.
import assert from "node:assert/strict";
import test from "node:test";
import { createKeyParser } from "../../scripts/dev-foreground-keys.mjs";
import { createMouseSelection } from "../../scripts/dev-foreground-selection.mjs";

test("fragmented forward and reverse drags copy identical multiline text", () => {
  for (const reverse of [false, true]) {
    const chunks = [];
    const state = { screenLines: ["first line", "second line"] };
    const selection = createMouseSelection({ state, output: { write: (chunk) => chunks.push(chunk) } });
    const parser = createKeyParser({ onMouse: selection.onMouse, onKey: () => assert.fail("Mouse input reached command") });
    const start = reverse ? "7;2" : "3;1";
    const end = reverse ? "3;1" : "7;2";
    parser.push(`\x1b[<0;${start}M`);
    assert.equal(state.selecting, true);
    state.screenLines = ["new logs must not affect selection"];
    parser.push("\x1b[<32;");
    parser.push(`${end}M\x1b[<0;${end}m`);
    assert.equal(state.selecting, false);
    const clipboard = chunks.join("").split("]52;c;")[1].split("\x07")[0];
    assert.equal(Buffer.from(clipboard, "base64").toString(), "rst line\nsecond ");
  }
});

test("single clicks and wheel events leave the clipboard untouched", () => {
  const chunks = [], wheels = [];
  const state = { screenLines: ["log"] };
  const selection = createMouseSelection({ state, output: { write: (chunk) => chunks.push(chunk) } });
  const parser = createKeyParser({ onMouse: selection.onMouse, onWheel: (delta) => wheels.push(delta) });
  parser.push("\x1b[<0;1;1M\x1b[<0;1;1m\x1b[<64;1;1M");
  assert.deepEqual(wheels, [1]);
  assert.equal(chunks.join("").includes("]52;"), false);
});

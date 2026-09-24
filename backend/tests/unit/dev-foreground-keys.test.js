import assert from "node:assert/strict";
import test from "node:test";

import { createKeyParser } from "../../scripts/dev-foreground-keys.mjs";

// Replays the reported bug: SGR/X10 click and scroll sequences must never
// leak digits into the prompt input.
function collect(pushes) {
  const keys = [];
  const wheels = [];
  const escapes = [];
  const parser = createKeyParser({
    onKey: (char) => keys.push(char),
    onWheel: (delta) => wheels.push(delta),
    onEscape: (sequence) => escapes.push(sequence)
  });
  for (const chunk of pushes) parser.push(chunk);
  return { keys, wheels, escapes };
}

test("SGR click reports are swallowed without leaking digits", () => {
  const seen = collect(["\x1b[<0;40;12M", "\x1b[<0;40;12m"]);
  assert.deepEqual(seen.keys, []);
  assert.deepEqual(seen.wheels, []);
});

test("SGR scroll wheel scrolls the log instead of typing", () => {
  const seen = collect(["\x1b[<64;40;12M", "\x1b[<65;40;12M"]);
  assert.deepEqual(seen.keys, []);
  assert.deepEqual(seen.wheels, [1, -1]);
});

test("X10 click and wheel reports are swallowed", () => {
  const seen = collect(["\x1b[M\x20\x28\x0c", "\x1b[M\x60\x28\x0c"]);
  assert.deepEqual(seen.keys, []);
  assert.deepEqual(seen.wheels, [1]);
});

test("split sequences across chunks stay whole", () => {
  const seen = collect(["\x1b[<64;4", "0;12M", "hi"]);
  assert.deepEqual(seen.keys, ["h", "i"]);
  assert.deepEqual(seen.wheels, [1]);
});

test("ordinary keys and arrows still pass through", () => {
  const seen = collect(["ab", "\x1b[A", "\x1b[D"]);
  assert.deepEqual(seen.keys, ["a", "b"]);
  assert.deepEqual(seen.escapes, ["\x1b[A", "\x1b[D"]);
});

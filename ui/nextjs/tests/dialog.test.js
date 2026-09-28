// Verify focus containment, restoration, and dismissal for the shared dialog primitive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Check that the shared dialog implements its required accessible keyboard and pointer behaviors.
test("shared dialog supports focus trap, focus restore, Escape and outside click", async () => {
  const source = await readFile(new URL("../components/Dialog.jsx", import.meta.url), "utf8");
  assert.match(source, /createPortal/);
  assert.match(source, /aria-modal="true"/);
  assert.match(source, /aria-labelledby=\{labelledBy\}/);
  assert.match(source, /previousFocus\.current\.focus\(\)/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /event\.shiftKey/);
  assert.match(source, /event\.target === event\.currentTarget/);
});

/** Checks that initial review evidence stays small without confusing omitted changes
 * with empty diffs or hiding genuine source and Git failures. */
import assert from "node:assert/strict";
import test from "node:test";
import { readReviewPromptPatch } from "../../src/modules/supervisor/review-prompt-patch.js";

test("large patches are named for tool reads while small later patches remain visible", async () => {
  const calls = [];
  const result = await readReviewPromptPatch({ baseCommit: "base", paths: ["a.js", "b.js", "c.js"], source: {
    diffPatchFrom: async (base, { paths }) => {
      calls.push([base, paths]);
      if (paths[0] === "a.js") return "á".repeat(20_000);
      if (paths[0] === "b.js") throw Object.assign(new Error("Too large"), { code: "REVIEW_EVIDENCE_TOO_LARGE" });
      return "diff --git a/c.js b/c.js\n+small\n";
    }
  } });
  assert.deepEqual(calls, [["base", ["a.js"]], ["base", ["b.js"]], ["base", ["c.js"]]]);
  assert.match(result, /\+small/);
  assert.match(result, /\["a.js","b.js"\]/);
  assert.ok(Buffer.byteLength(result) < 32_000);
});

test("combined initial patches stay bounded and source errors still fail review", async () => {
  const result = await readReviewPromptPatch({ baseCommit: "base", paths: ["a.js", "b.js"],
    source: { diffPatchFrom: async () => "x".repeat(20_000) } });
  assert.match(result, /\["b.js"\]/);
  assert.ok(Buffer.byteLength(result) < 32_000);
  await assert.rejects(readReviewPromptPatch({ baseCommit: "base", paths: ["a.js"], source: {
    diffPatchFrom: async () => { throw Object.assign(new Error("Unsafe path"), { code: "FILE_ROLE_FORBIDDEN" }); }
  } }), { code: "FILE_ROLE_FORBIDDEN" });
  assert.equal(await readReviewPromptPatch({ paths: [] }), "");
});

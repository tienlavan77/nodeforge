/**
 * Verifies that implementation agents and independent reviewers receive the same
 * approved editorial targets, counting convention and new-code scope. Effective
 * prompt assertions protect policy meaning without fixing incidental formatting.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PURPOSE_COMMENT_GUIDANCE } from "../../src/shared/purpose-comment-guidance.js";
import { buildCodexTicketPrompt, buildToolTicketPrompt, COMPLEXITY_FALLBACK } from "../../src/modules/supervisor/nodeforge-task-prompts.js";
import { reviewVerdictInstructions } from "../../src/modules/supervisor/review/review-verdict-request.js";

/** Checks mandatory editorial content while allowing Markdown and whitespace changes. */
function assertGuidance(content) {
  const text = content.replace(/\s+/g, " ");
  for (const [kind, range] of [["Simple function", "15–50"], ["Ordinary function", "30–100"], ["Complex function", "80–180"], ["File/module", "60–180"]]) {
    assert.ok(text.includes(kind) && text.includes(range));
  }
  assert.match(text, /non-empty whitespace-separated units after normalization/);
  assert.match(text, /comment delimiters and decorative prefixes do not count/);
  assert.match(text, /Vietnamese.*technical counting convention, not linguistic word segmentation/);
  assert.match(text, /warnings or review guidance only/);
  assert.match(text, /Short but meaningful comments and longer comments with a reason remain acceptable/);
  assert.match(text, /new files and new functions\/symbols only/i);
  assert.match(text, /entirely in English or entirely in Vietnamese/);
  assert.match(text, /technical terms are allowed/);
  assert.match(text, /Never include secrets/);
  assert.match(text, /Do not require summaries on existing code or rewrite historical comments/);
}

test("shared guidance contains the approved O5 editorial policy", () => assertGuidance(PURPOSE_COMMENT_GUIDANCE));
for (const buildPrompt of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
  for (const [direct, immutable] of [[false, false], [true, false], [false, true]]) {
    test(`${buildPrompt.name} direct=${direct} immutable=${immutable} shares O5 guidance`, () => {
      assertGuidance(buildPrompt({ id: "O5", acceptance_criteria: [] }, null, ["backend"], COMPLEXITY_FALLBACK, direct, immutable));
    });
  }
}
test("independent reviewer instructions share advisory policy without expanding the gate", () => {
  assertGuidance(reviewVerdictInstructions());
});

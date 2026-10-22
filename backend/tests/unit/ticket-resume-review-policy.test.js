// Prevents review-policy amendments and incomplete recovery checkpoints from crashing Coder resume.
import assert from "node:assert/strict";
import test from "node:test";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";

test("a resolved checkpoint without a disposition does not fabricate guidance or crash", () => {
  const state = createResumeState({ status: "failed", last_completed_turn: 2, blocker_recovery: { status: "resolved" } });
  const prompt = buildResumePrompt("Implement the ticket", state);
  assert.match(prompt, /completing turn 2/);
  assert.doesNotMatch(prompt, /Automatic blocker investigation resolved/);
});

test("an Owner policy amendment resumes findings without claiming an AM decision", () => {
  const state = createResumeState({ status: "failed", last_completed_turn: 2,
    review_policy_amendment: ".forge/runtime/review-policy-amendment/receipt.json",
    blocker_recovery: { status: "superseded", reason: "owner_review_policy_amended" } });
  const prompt = buildResumePrompt("Implement the ticket", state);
  assert.match(prompt, /no fixed limit on Coder revision\/Reviewer cycles/);
  assert.match(prompt, /preserve independent review, verification, scope/);
  assert.doesNotMatch(prompt, /Automatic blocker investigation resolved/);
});

test("a recorded technical disposition still reaches the resumed Coder", () => {
  const state = createResumeState({ status: "failed", blocker_recovery: { status: "resolved", disposition: { guidance: "Repair the parser with focused coverage." } } });
  assert.match(buildResumePrompt("Implement the ticket", state), /Repair the parser with focused coverage/);
});

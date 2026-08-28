import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTicketResult } from "../../web/src/services/ticket-result-summary.js";

test("summarizes completed ticket files, commit, and diff", () => {
  assert.equal(summarizeTicketResult({ payload: { to: "done", files: ["web/src/main.jsx"], commit: "abc123", insertions: 4, deletions: 2 } }), "Ticket completed. Files: web/src/main.jsx. Commit: abc123. Changes: +4/-2.");
});

test("summarizes provider failures with retry guidance", () => {
  assert.match(summarizeTicketResult({ payload: { to: "failed", error_code: "UPSTREAM_503", error: "Codex gateway returned HTTP 503" } }), /temporary provider error; please try again/);
});

test("preserves configuration failure text", () => {
  assert.equal(summarizeTicketResult({ payload: { status: "failed", error_code: "CONFIGURATION_ERROR", error: "Agent path must stay under src/ or tests/" } }), "Ticket failed: CONFIGURATION_ERROR: Agent path must stay under src/ or tests/");
});

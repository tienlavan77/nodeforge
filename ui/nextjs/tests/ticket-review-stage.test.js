// Verifies ticket cards prevent duplicate active review and expose Resume for a parked review checkpoint.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["ui/nextjs/components/ticket-detail-modal.jsx"], bundle: true, write: false,
  platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
const component = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), component, component.exports);

// Renders real ticket controls with the backend's active or resumable review projection.
function renderReview(resumable) {
  return renderToStaticMarkup(createElement(component.exports.TicketCard, { projectId: "P", client: {}, ticket: {
    id: "T", status: "reviewing", title: "Review sessions", checkpoint: { phase: "review", active_stage: "reviewer", resumable } } }));
}

test("an active review disables Run", () => {
  const html = renderReview(false);
  assert.match(html, /disabled=""[^>]*>Run<\/button>/);
  assert.doesNotMatch(html, />Resume<\/button>/);
});

test("a parked review offers enabled Resume and identifies Reviewer", () => {
  const html = renderReview(true);
  assert.match(html, /Checkpoint tại RV \(Reviewer\)/);
  assert.match(html, /<button[^>]*is-resume[^>]*>Resume<\/button>/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Resume<\/button>/);
});

test("a timed-out Coder shows why it stopped and enables Resume without Human Approve", () => {
  const html = renderToStaticMarkup(createElement(component.exports.TicketCard, { projectId: "P", client: {}, ticket: {
    id: "T", status: "failed", title: "Resume timed-out work", checkpoint: { phase: "sdk_timeout", active_stage: "coder", resumable: true,
      last_completed_turn: 125, failure: { code: "SDK_REQUEST_TIMEOUT", message: "Codex SDK request timed out for CODER.", resume_allowed: true } } } }));
  assert.match(html, /role="alert"/);
  assert.match(html, /SDK_REQUEST_TIMEOUT/);
  assert.match(html, /Bấm Resume để tiếp tục từ checkpoint/);
  assert.match(html, /turn 125/);
  assert.match(html, /is-resume[^>]*>Resume<\/button>/);
  assert.doesNotMatch(html, /disabled=""[^>]*>Resume<\/button>|Human Approve|>Stop<\/button>/);
});

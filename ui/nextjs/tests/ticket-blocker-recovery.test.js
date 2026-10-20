// Verifies automatic blocker progress and owner proposals render safely without an approval bypass.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["ui/nextjs/components/ticket-blocker-recovery.jsx"], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), componentModule, componentModule.exports);
const { TicketBlockerRecovery } = componentModule.exports;

test("a waiting ticket card exposes Stop and disables Run while keeping its checkpoint", async () => {
  const cardBuild = await build({ entryPoints: ["ui/nextjs/components/ticket-detail-modal.jsx"], bundle: true, write: false,
    platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
  const cards = { exports: {} };
  new Function("require", "module", "exports", cardBuild.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), cards, cards.exports);
  const html = renderToStaticMarkup(createElement(cards.exports.TicketCard, { projectId: "P", client: {}, ticket: {
    id: "T", status: "needs_human_review", title: "Continue the ticket", checkpoint: { approval_retry: { interval_ms: 30_000 }, last_completed_turn: 97 } } }));
  assert.match(html, /30 giây.*Stop/);
  assert.match(html, /<button[^>]*>Stop<\/button>/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Run<\/button>/);
});

test("approval outage shows the 30-second automatic retry and Stop without owner review controls", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "approval_retry_pending" }, onDecide: () => {} }));
  assert.match(html, /503/);
  assert.match(html, /30 giây.*checkpoint.*Stop/);
  assert.doesNotMatch(html, /Owner quyết định|Ghi quyết định|SL \/ Architecture/);
});

test("pending recovery explains that owner need not reset or RUN the ticket", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "pending" } }));
  assert.match(html, /SL \/ Architecture/);
  assert.match(html, /không cần reset hoặc RUN lại/);
  assert.doesNotMatch(html, /<button/);
});

test("owner sees the concrete proposal and recommendation but no implicit approval action", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "owner_required", proposal: {
    title: "Choose the lifecycle contract", options: [{ id: "retain", description: "Preserve the existing contract <script>unsafe()</script>" }], recommended_option_id: "retain" } } }));
  assert.match(html, /Choose the lifecycle contract/);
  assert.match(html, /khuyến nghị/);
  assert.match(html, /Contract\/scope mới phải qua gate duyệt plan đúng revision/);
  assert.doesNotMatch(html, /<script>/);
});

test("an onDecide callback renders the explicit owner decision form with option selection", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "owner_required", proposal: {
    title: "Choose the lifecycle contract", options: [{ id: "retain", description: "Preserve the existing contract." }], recommended_option_id: "retain" } },
    onDecide: () => {} }));
  assert.match(html, /Owner quyết định blocker này/);
  assert.match(html, /Ghi quyết định/);
  assert.match(html, /name="blocker-decision-option"/);
});

test("a recorded owner decision is shown instead of the form", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "owner_required", proposal: {
    title: "Choose the lifecycle contract", options: [{ id: "retain", description: "Preserve." }], recommended_option_id: "retain" },
    owner_decision: { option_id: "retain", decided_at: "2026-10-16T05:00:00.000Z", reason: "Stability first." } },
    onDecide: () => {} }));
  assert.match(html, /Owner đã quyết:.*retain/);
  assert.doesNotMatch(html, /Ghi quyết định/);
});

test("cancelled investigation preserves checkpoint messaging instead of asking for approval", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "cancelled" } }));
  assert.match(html, /checkpoint được giữ nguyên/);
  assert.equal(renderToStaticMarkup(createElement(TicketBlockerRecovery, {})), "");
});

test("technical reconciliation is not presented as an owner policy approval", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "reconciliation_required",
    proposal: { title: "Provider outcome unknown", options: [{ id: "reconcile", description: "Reconcile provider ownership before another invocation." }], recommended_option_id: "reconcile" } } }));
  assert.match(html, /không phải yêu cầu owner quyết định policy/);
  assert.match(html, /Không tự reset hoặc replay/);
  assert.doesNotMatch(html, /AM xác định vấn đề vượt quyền|<button/);
});

test("owner escalation displays the exact AM boundary and rationale", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "owner_required",
    escalation: { boundary: "system_structure", rationale: "Replace the approved in-process topology." } } }));
  assert.match(html, /system_structure/);
  assert.match(html, /Replace the approved in-process topology/);
  assert.match(html, /SL tự quyết trong Sprint Plan/);
});

test("governance handoff shows the review identity without repeating the owner choice or granting RUN", () => {
  const html = renderToStaticMarkup(createElement(TicketBlockerRecovery, { recovery: { status: "governance_required",
    owner_decision: { option_id: "http" }, proposal: { title: "Repeat vote", options: [] },
    governance_handoff: { plan_id: "PLAN-CONTRACT-123", revision: 1, sha256: "a".repeat(64), source_path: ".forge/runtime/nf/plans/PLAN-CONTRACT-123/ke-hoach-r1.md" } }, onDecide: () => {} }));
  assert.match(html, /PLAN-CONTRACT-123/);
  assert.match(html, /ke-hoach-r1.md/);
  assert.match(html, /Chưa cấp approval, RUN/);
  assert.doesNotMatch(html, /Repeat vote|Ghi quyết định|Ticket đã về pending|AM xác định vấn đề vượt quyền/);
});

test("Human Approve modal closes on approval and auto-resumes when the blocker decision has no active backend handoff", async () => {
  const review = await readFile(new URL("../components/ticket-human-review.jsx", import.meta.url), "utf8");
  const card = await readFile(new URL("../components/ticket-detail-modal.jsx", import.meta.url), "utf8");
  assert.match(review, /const decided = await client\.decideTicketBlocker\(/);
  assert.match(review, /onApproved\?\.\(await client\.getTicket\(projectId, ticket\.id\), \{ autoResume: !decided\?\.handoff \}\)/);
  assert.match(card, /onApproved=\{async \(updatedTicket, options\) => \{ setReviewOpen\(false\); setDetail\(null\); if \(options\?\.autoResume && updatedTicket\?\.status !== "done"\) await run\(\); await onRefresh\?\.\(\); \}\}/);
});


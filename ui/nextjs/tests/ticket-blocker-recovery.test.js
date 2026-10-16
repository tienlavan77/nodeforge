// Verifies automatic blocker progress and owner proposals render safely without an approval bypass.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const compiled = await build({ entryPoints: ["ui/nextjs/components/ticket-blocker-recovery.jsx"], bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
const componentModule = { exports: {} };
new Function("require", "module", "exports", compiled.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), componentModule, componentModule.exports);
const { TicketBlockerRecovery } = componentModule.exports;

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

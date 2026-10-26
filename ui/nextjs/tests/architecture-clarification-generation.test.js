// Verifies an in-flight Architecture plan displays progress rather than owner
// authentication or a second generation action, and closes after persistence.
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { build } from "esbuild";

const bundle = await build({ entryPoints: ["ui/nextjs/components/architecture-clarification-card.jsx"], bundle: true, write: false,
  platform: "node", format: "cjs", jsx: "automatic", external: ["react", "react/*"] });
const component = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(new URL("../package.json", import.meta.url)), component, component.exports);

// Renders the actual client component against the durable backend session projection.
function renderSession(status, questions = []) {
  return renderToStaticMarkup(createElement(component.exports.ArchitectureClarificationCard, { session: {
    session_id: "CLARIFY-A", version: 2, status, questions, selections: {}, notes: {}, source_path: "plans/conversation-intake.json" } }));
}

test("automatic generation shows progress without a token field or clickable generation action", () => {
  const html = renderSession("generating");
  assert.match(html, /Đang tạo kế hoạch/);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /type="password"|<button|Architecture cần owner chốt quyết định|0\/0/);
});

test("successful generation removes the clarification card", () => {
  assert.equal(renderSession("completed"), "");
});

test("a real generation failure keeps the authenticated retry action available", () => {
  const html = renderSession("generation_failed");
  assert.match(html, /type="password"/);
  assert.match(html, /Thử tạo plan lại/);
});

test("actual owner questions still show explicit choices and authentication", () => {
  const html = renderSession("awaiting_owner_decisions", [{ id: "STORAGE", title: "Storage", reason: "Owner data policy",
    options: [{ id: "LOCAL", label: "Local", description: "Local data" }, { id: "SERVER", label: "Server", description: "Account data" }] }]);
  assert.match(html, /Architecture cần owner chốt quyết định/);
  assert.match(html, /type="password"/);
  assert.match(html, /type="radio"/);
});

// Prevents the sidebar-free Coding page from being squeezed into Home's 350px conversation track.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");

// Read individual CSS declarations so layout assertions do not depend on declaration order.
function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = styles.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "m"))?.[1];
  assert.ok(body, `Missing rule: ${selector}`);
  return Object.fromEntries(body.split(";").filter((entry) => entry.includes(":")).map((entry) => {
    const separator = entry.indexOf(":");
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }));
}

test("Coding pins flow-preserving headers inside each independently scrolling column", () => {
  const column = declarations(".coding-workspace-column");
  assert.equal(column["min-height"], "0");
  assert.equal(column["overflow-y"], "auto");
  assert.equal(column["overflow-x"], "hidden");
  const header = declarations(".coding-workspace-column-header");
  assert.equal(header.position, "sticky");
  assert.equal(header.top, "0");
  assert.equal(header.background, "var(--app-panel)");
  assert.equal(header["flex-wrap"], "wrap");
  assert.equal(declarations(".coding-workspace-git-status")["margin-left"], "auto");
  for (const heading of ["coding-sprint-plan-heading", "coding-workspace-agent-heading"]) {
    assert.match(monitor, new RegExp(`<header\\b(?=[^>]*className="coding-workspace-column-header")[^>]*>\\s*<h1\\b(?=[^>]*id="${heading}")[^>]*>`));
  }
  const git = monitor.match(/<GitStatusIndicator\b[^>]*\/>/)?.[0];
  assert.ok(git);
  assert.match(git, /\bclient\s*=\s*\{client\}/);
  assert.match(git, /\bprojectId\s*=\s*\{projectId\}/);
  const wiring = page.match(/<CodingWorkspaceMonitor\b[^>]*\/>/)?.[0];
  assert.match(wiring, /\bprojectId\s*=\s*\{PROJECT_ID\}/);
  assert.match(wiring, /\bclient\s*=\s*\{client\}/);
});

test("Coding agent list adapts to one, two or at most three columns without widening panels", () => {
  assert.equal(declarations(".coding-workspace-list")["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(declarations(".coding-workspace-agent")["container-type"], "inline-size");
  for (const [width, columns] of [[490, 2], [740, 3]]) {
    assert.match(styles, new RegExp(`@container\\s+coding-agents\\s*\\(min-width:\\s*${width}px\\)\\s*\\{\\s*\\.coding-workspace-list\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(${columns},\\s*minmax\\(0,\\s*1fr\\)\\)`));
  }
  assert.doesNotMatch(styles, /grid-template-columns:\s*repeat\([4-9]/);
  assert.equal(declarations(".coding-agent-monitor")["min-width"], "0");
  assert.equal(declarations(".coding-agent-monitor header")["flex-wrap"], "wrap");
  assert.equal(declarations(".coding-agent-monitor header > button")["flex-shrink"], "0");
});

test("Coding restores navigation before the workspace without conversation controls", () => {
  assert.match(page, /className="claude-home-shell coding-workspace-shell"/);
  assert.ok(page.indexOf("<ConversationSidebar") < page.indexOf("<CodingWorkspaceMonitor"));
  assert.match(page, /showConversationControls=\{false\}/);
  assert.match(page, /open=\{openSidebar\} onOpen=\{\(\) => setOpenSidebar\(true\)\} onClose=\{\(\) => setOpenSidebar\(false\)\}/);
  assert.match(styles, /\.claude-home-shell\.coding-workspace-shell\s*\{[^}]*grid-template-columns:\s*350px minmax\(0, 1fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.ok(globals.indexOf('styles/workspace-monitors.css') > globals.indexOf('styles/home-workspace.css'));
});

test("Coding fills the viewport and keeps scrollable columns without changing Home or the internal split", () => {
  assert.match(styles, /\.coding-workspace-shell > \.coding-workspace-monitor\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*height:\s*100%;[^}]*overflow:\s*auto/);
  assert.match(styles, /\.coding-workspace-shell \.coding-workspace-column\s*\{[^}]*min-height:\s*0;[^}]*box-sizing:\s*border-box/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(260px, 2fr\)/);
  assert.match(styles, /@media \(max-width: 760px\)[^\n]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(styles, /\.claude-home-shell\s*\{/);
  assert.match(styles, /coding-workspace-shell:has\(\.conversation-sidebar.is-collapsed\)\s*\{[^}]*grid-template-columns:\s*42px minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?padding-left:\s*56px/);
  assert.match(styles, /coding-workspace-shell \.conversation-mobile-rail\s*\{[^}]*display:\s*flex;[^}]*top:\s*0/);
  assert.match(styles, /@media \(min-width: 641px\)[\s\S]*?responsive-region--conversations\s*\{[^}]*position:\s*static/);
});

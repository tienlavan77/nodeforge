// Prevents the sidebar-free Coding page from being squeezed into Home's 350px conversation track.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

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

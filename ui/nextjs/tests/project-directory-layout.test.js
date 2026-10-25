// Guard the header-free project landing page, centered layout and NodeForge introduction.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transformSync } from "esbuild";

const directory = await readFile(new URL("../components/project-directory.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/projects-directory.css", import.meta.url), "utf8");
const workspace = await readFile(new URL("../components/project-workspace.jsx", import.meta.url), "utf8");

// Keep the landing page brand in the main content rather than a navigation header.
test("project landing page has a standalone brand and valid JSX", () => {
  assert.doesNotThrow(() => transformSync(directory, { loader: "jsx" }));
  assert.doesNotMatch(directory, /className="topbar"|<NodeForgeHeader/);
  assert.match(directory, /<h1 id="projects-brand-title">NodeForge<\/h1>/);
  assert.match(directory, /<ProjectCard key=\{project.project_id\}/);
  assert.match(directory, /aria-label="Add project"/);
  assert.match(directory, /role="alert"/);
  assert.match(directory, /onClick=\{load\}/);
  assert.match(directory, /Showing the last known project list/);
  assert.doesNotMatch(directory, /API unavailable/);
  assert.doesNotMatch(directory, /if \(error\) return <main className="project-workspace-state"/);
  // The directory shell must always render; only an inline banner may announce a lost connection.
  assert.ok(directory.includes('<div className="app-shell app-shell-control-room projects-directory-shell">'));
  assert.match(directory, /className="project-workspace-stale" hidden=\{!statusMessage\}/);
});

// An admitted workspace must keep its mounted children when a later refresh fails, and only an
// un-admitted workspace or a genuinely removed project may fall back to the replacement notice.
test("workspace holds its admitted page during an API outage instead of showing a placeholder", () => {
  assert.doesNotThrow(() => transformSync(workspace, { loader: "jsx" }));
  const heldIndex = workspace.indexOf("if (heldProject)");
  const noticeIndex = workspace.indexOf("return <main className=\"project-workspace-state\">\n    <p role=\"alert\">");
  assert.ok(heldIndex !== -1, "the held-project branch must exist");
  assert.ok(heldIndex < noticeIndex, "a held project must render before any outage notice");
  assert.match(workspace, /if \(heldProject\)[\s\S]*<Fragment key=\{selection\.generation\}>[\s\S]*\{children\}/);
  assert.doesNotMatch(workspace, /API unavailable/);
});

// Keep project selection centered while allowing long lists and narrow screens to grow.
test("project landing layout centers cards and adapts to mobile", () => {
  assert.match(styles, /\.projects-directory-shell\s*\{[^}]*height: auto;[^}]*overflow: visible;/);
  assert.match(styles, /\.projects-directory\s*\{[^}]*min-height: 100dvh;[^}]*margin: 0 auto;[^}]*justify-content: center;[^}]*align-items: center;/);
  assert.match(styles, /\.projects-directory \.projects-card-grid\s*\{[^}]*flex-wrap: wrap;[^}]*justify-content: center;/);
  assert.match(styles, /@media \(max-width: 600px\)[\s\S]*\.projects-features\s*\{\s*grid-template-columns: 1fr;/);
});

// Explain the product through planning, agent collaboration and visible verification with primary/secondary hierarchy.
test("project landing introduces NodeForge capabilities", () => {
  assert.match(directory, /className="projects-stage"/);
  assert.match(directory, /aria-labelledby="projects-introduction-title" lang="vi"/);
  for (const heading of ["Làm rõ ý tưởng", "Phối hợp thực hiện", "Theo dõi &amp; kiểm chứng"]) {
    assert.ok(directory.includes(`<h3>${heading}</h3>`));
  }
  assert.match(directory, /Architecture Manager/);
  assert.match(styles, /\.projects-stage\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/);
  assert.match(styles, /\.projects-card-grid > \.agent-directory-card\s*\{[^}]*flex:\s*0 1 210px;/);
  assert.match(styles, /\.projects-workspace-panel\s*\{[^}]*margin:\s*24px 0;[^}]*padding:\s*12px 0;/);
  assert.match(styles, /\.projects-feature-step\s*\{[^}]*font-size:\s*24px !important;/);
  assert.match(styles, /\.projects-features h3\s*\{[^}]*color:\s*var\(--cyan-300, var\(--app-accent\)\)/);
});

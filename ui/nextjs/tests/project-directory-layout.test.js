// Guard the header-free project landing page, centered layout and NodeForge introduction.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { transformSync } from "esbuild";

const directory = await readFile(new URL("../components/project-directory.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/projects-directory.css", import.meta.url), "utf8");

// Keep the landing page brand in the main content rather than a navigation header.
test("project landing page has a standalone brand and valid JSX", () => {
  assert.doesNotThrow(() => transformSync(directory, { loader: "jsx" }));
  assert.doesNotMatch(directory, /className="topbar"|<NodeForgeHeader/);
  assert.match(directory, /<h1 id="projects-brand-title">NodeForge<\/h1>/);
  assert.match(directory, /<ProjectCard key=\{project.project_id\}/);
  assert.match(directory, /aria-label="Add project"/);
  assert.match(directory, /role="alert"/);
  assert.match(directory, /onClick=\{load\}/);
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

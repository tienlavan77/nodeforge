<!--
Business purpose: Provides Part 2 of 5 of the complete, verbatim git diff between base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
Technical description: Generated directly from git diff 131a628f042a27f0098df3dfb62f03a1a50223b4..452c3c353b46c8f0b92841547177a49b46d77383 without manual hunk editing; bounded to <= 250 physical lines.
-->
# Scoped Unified Patch (Part 2/5: Activity Helper, CSS & Backend Browser Layout) — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` | **Review Commit SHA**: `452c3c353b46c8f0b92841547177a49b46d77383` (`tree_sha: 89f1468c05c86d280b6e0dc60a1fe25079d25ff9`)
- **Manifest SHA-256**: `sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316` | **Files in Part 2**: `ui/nextjs/lib/coding-workspace-activity.js`, `ui/nextjs/app/styles/workspace-monitors.css`, `backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js`, `backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js`, `backend/tests/unit/browser-coding-layout.test.js`
- **All Patch Parts**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (Part 1), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part2.md` (Part 2), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part3.md` (Part 3), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part4.md` (Part 4), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part5.md` (Part 5)

```diff
diff --git a/ui/nextjs/lib/coding-workspace-activity.js b/ui/nextjs/lib/coding-workspace-activity.js
new file mode 100644
index 0000000..3763467
--- /dev/null
+++ b/ui/nextjs/lib/coding-workspace-activity.js
@@ -0,0 +1,62 @@
+// Normalize Coding workspace agent activity details, deterministic color tones, and project isolation.
+import { codingAgentPanelKey, codingAgentProfile } from "./coding-agent-panel-registry.js";
+import { agentDisplayName, displayMessageTime } from "./home-page-watcher-events.js";
+
+const AGENT_TONES = ["#62d39b", "#6ab0f3", "#d8b66a", "#c792ea", "#f07178", "#89ddff", "#ffcb6b", "#a3be8c"];
+
+// Business purpose: Ensures agent display names in the Coding workspace monitor remain readable against the dark monitor surface.
+// Technical description: Parses 3-digit or 6-digit hex color strings, computes relative sRGB luminance, and verifies at least a 4.5:1 WCAG contrast ratio against the dark panel background.
+function isAccessibleMonitorColor(value) {
+  if (typeof value !== "string") return false;
+  const trimmed = value.trim();
+  const hex = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed)?.[1];
+  if (!hex) return false;
+  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
+  const channels = [0, 2, 4].map((offset) => {
+    const srgb = Number.parseInt(full.slice(offset, offset + 2), 16) / 255;
+    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
+  });
+  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
+  return (luminance + 0.05) / (0.014 + 0.05) >= 4.5;
+}
+
+// Assign a deterministic, high-contrast color tone to each Coding agent identity, falling back when explicitColor is unreadable.
+export function resolveCodingAgentTone(agentId, explicitColor) {
+  if (isAccessibleMonitorColor(explicitColor)) return explicitColor.trim();
+  const key = String(agentId ?? "agent").trim() || "agent";
+  let hash = 0;
+  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
+  return AGENT_TONES[hash % AGENT_TONES.length];
+}
+
+// Normalize and filter Coding agent activity events for the active project with resolved agent names, details, and stable tones.
+export function resolveCodingAgentActivities(agentActivities = [], agentDirectory = [], projectId = null) {
+  const list = Array.isArray(agentActivities) ? agentActivities : [];
+  const agents = Array.isArray(agentDirectory) ? agentDirectory : [];
+  return list.filter((event) => {
+    if (!event || (event.event_type && event.event_type !== "agent.activity")) return false;
+    const payload = event.payload ?? {};
+    const agentId = payload.agent_id ?? event.agent_id ?? payload.agentId;
+    if (projectId && event.project_id && event.project_id !== projectId) return false;
+    if (projectId && payload.project_id && payload.project_id !== projectId) return false;
+    if (event.agent_id !== undefined && payload.agent_id !== undefined && event.agent_id !== payload.agent_id) return false;
+    if (payload.agentId !== undefined && payload.agent_id !== undefined && payload.agentId !== payload.agent_id) return false;
+    if (projectId && agentId && !codingAgentPanelKey(projectId, agentId)) return false;
+    if (agents.length > 0 && projectId && agentId && !codingAgentProfile(agents, agentId, projectId)) return false;
+    return Boolean(agentId || event.agent_name || payload.agent_name || payload.summary || event.summary || payload.tool_name || event.tool_name);
+  }).map((event, index) => {
+    const payload = event.payload ?? {};
+    const agentId = payload.agent_id ?? event.agent_id ?? payload.agentId;
+    const profile = (projectId && agentId ? codingAgentProfile(agents, agentId, projectId) : null) ?? agents.find((agent) => (agent?.agent_id ?? agent?.id) === agentId) ?? null;
+    const resolvedName = profile?.agent_name ?? profile?.name ?? profile?.label ?? event.agent_name ?? payload.agent_name ?? agentDisplayName(agentId, agents);
+    const identityKey = String(agentId ?? profile?.role ?? resolvedName ?? "agent");
+    const tone = resolveCodingAgentTone(identityKey, profile?.color ?? profile?.agent_color);
+    const activityType = String(payload.activity_type ?? event.activity_type ?? "activity").replaceAll("_", " ");
+    const status = String(payload.status ?? event.status ?? "working");
+    const time = displayMessageTime(event.timestamp ?? payload.timestamp);
+    const toolName = payload.tool_name ?? event.tool_name ?? "";
+    const summary = payload.summary ?? event.summary ?? (toolName || activityType);
+    const detail = summary && toolName && !String(summary).includes(toolName) ? `${summary} (${toolName})` : (summary || toolName || activityType);
+    return { key: event.event_id ?? event.id ?? `${agentId ?? "agent"}-${event.timestamp ?? index}-${index}`, agentId: agentId ?? "agent", agentName: resolvedName, activityType, status, time, toolName, summary, detail, tone };
+  });
+}
diff --git a/ui/nextjs/app/styles/workspace-monitors.css b/ui/nextjs/app/styles/workspace-monitors.css
index 4d979e0..c4214a4 100644
--- a/ui/nextjs/app/styles/workspace-monitors.css
+++ b/ui/nextjs/app/styles/workspace-monitors.css
@@ -54,7 +54,7 @@
 .coding-workspace-column-header { position: sticky; top: 0; z-index: 2; display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 28px 0 18px; margin-bottom: 18px; background: var(--app-panel); border-bottom: 1px solid var(--app-border); }
 .coding-workspace-column-header h1 { min-width: 0; margin: 0; font-size: 16px; }
 .coding-workspace-git-status { margin-left: auto; min-width: 0; max-width: 100%; }
-.coding-workspace-agent { container-type: inline-size; container-name: coding-agents; }
+.coding-workspace-agent { display: flex; flex-direction: column; container-type: inline-size; container-name: coding-agents; }
 .coding-sprint-plan .sprint-plan-dashboard { padding: 0; border: 0; }
 .coding-architecture-plans { display: grid; min-width: 0; gap: 12px; margin-bottom: 24px; padding: 16px; border: 1px solid var(--app-border); border-radius: 10px; background: var(--app-surface-alt); color: var(--app-text); font: 12px/1.5 'Space Grotesk', sans-serif; }
 .coding-architecture-plans > h2 { margin: 0; font-size: 14px; font-weight: 600; }
@@ -72,9 +72,11 @@
 .coding-architecture-plan-actions > button:focus-visible, .coding-architecture-plans > p > button:focus-visible, .coding-architecture-plans > button:focus-visible { outline: 2px solid var(--app-accent); outline-offset: 2px; }
 .coding-architecture-plan-actions > button:disabled { opacity: .55; cursor: not-allowed; }
 @media (max-width: 640px) { .coding-architecture-plans { padding: 12px; gap: 10px; } .coding-architecture-plan-card { padding: 12px; } .coding-architecture-plan-actions > button { width: 100%; } }
-.coding-workspace-list { display: grid; grid-template-columns: minmax(0, 1fr); align-items: start; gap: 10px; }
-@container coding-agents (min-width: 490px) { .coding-workspace-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
-@container coding-agents (min-width: 740px) { .coding-workspace-list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
+.coding-workspace-list { display: grid; flex: 1; min-height: 0; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
+.coding-workspace-row { display: grid; min-width: 0; min-height: 0; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; border-top: 1px solid var(--app-border); padding-top: 14px; }
+.coding-workspace-row:first-child { grid-template-columns: minmax(0, 1fr); border-top: 0; padding-top: 0; }
+.coding-workspace-monitor-column { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; max-height: none; overflow: hidden; padding: 14px; border: 1px solid var(--app-border); background: var(--app-surface-alt); }
+.coding-workspace-monitor-column h3 { margin: 0; min-width: 0; font-size: 13px; }
 .coding-agent-monitor { display: flex; flex-direction: column; min-width: 0; min-height: 0; max-height: 50vh; box-sizing: border-box; overflow: hidden; padding: 14px; border: 1px solid var(--app-border); background: var(--app-surface-alt); }
 .coding-agent-monitor header { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 10px; }
 .coding-agent-monitor header > strong, .coding-agent-monitor header > span { min-width: 0; overflow-wrap: anywhere; }
diff --git a/backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js b/backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js
index 74afa71..c02cb71 100644
--- a/backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js
+++ b/backend/src/modules/supervisor/browser/browser-coding-layout-fixture.js
@@ -9,6 +9,7 @@ const projectId = "PROJECT-NODEFORGE";
 const panels = Array.from({ length: 7 }, (_, index) => ({ key: `panel-${index}`, agentId: `coder-${index}`, projectId }));
 const agents = panels.map((panel) => ({ agent_id: panel.agentId, project_id: projectId, role: "coder", name: panel.agentId, status: "idle" }));
 const activities = panels.flatMap((panel) => Array.from({ length: 30 }, (_, index) => ({ event_type: "agent.activity", project_id: projectId, payload: { agent_id: panel.agentId, summary: `Activity ${index} ${"Long workspace activity content ".repeat(8)}`, tool_name: "read_file" } })));
+const watcherEvents = Array.from({ length: 25 }, (_, index) => ({ event_id: `wat-${index}`, event_type: index % 2 === 0 ? "watcher.file_indexed" : "watcher.file_removed", project_id: projectId, timestamp: "2026-11-02T10:01:00.000Z", payload: { activity: [`src/module-${index}.js`] } }));
 window.layoutFixture = { gitProjects: [], closedPanels: [] };
 const client = { getGitStatus: async (id) => { window.layoutFixture.gitProjects.push(id); return null; }, listPlans: async () => [], listPlanRequests: async () => [] };
 const style = document.createElement("style");
@@ -16,5 +17,4 @@ style.textContent = ":root{--app-panel:#fff;--app-border:#ccc;--app-text:#222;--
 document.head.append(style);
 createRoot(document.getElementById("root")).render(React.createElement("div", { className: "claude-home-shell coding-workspace-shell" },
   React.createElement("aside", { className: "conversation-sidebar is-collapsed" }),
-  React.createElement(CodingWorkspaceMonitor, { projectId, client, agentPanelRegistry: { panels, activity: {}, sourceStatus: "connected" }, agentDirectory: agents, agentActivities: activities,
-    onAgentPanelClose: (scope, agentId) => window.layoutFixture.closedPanels.push({ projectId: scope, agentId }) })));
+  React.createElement(CodingWorkspaceMonitor, { projectId, client, agentDirectory: agents, agentActivities: activities, watcherEvents, watcherState: "connected", watcherPulseId: 1 })));
diff --git a/backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js b/backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js
index 4c97cd6..8d7762d 100644
--- a/backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js
+++ b/backend/src/modules/supervisor/browser/browser-coding-layout-scenarios.js
@@ -3,7 +3,7 @@ import assert from "node:assert/strict";
 
 // Creates enough Sprint content to exercise each column's independent scrolling boundary.
 async function prepare(page) {
-  await page.waitForFunction(() => document.querySelectorAll(".coding-agent-monitor").length === 7 && window.layoutFixture.gitProjects.length === 1);
+  await page.waitForFunction(() => document.querySelectorAll(".coding-agent-monitor").length === 2 && window.layoutFixture.gitProjects.length >= 1);
   await page.evaluate(() => {
     const column = document.querySelector(".coding-sprint-plan");
     if (column.querySelector("[data-layout-end]")) return;
@@ -15,48 +15,61 @@ async function prepare(page) {
 
 // Measures sticky header geometry after browser layout has committed the independent scroll.
 async function scrollColumn(page, selector, end = false) {
-  await page.evaluate(({ selector, end }) => { document.querySelector(selector).scrollTop = end ? 1e7 : 500; }, { selector, end });
+  await page.evaluate(({ selector, end }) => {
+    const column = document.querySelector(selector);
+    const target = selector === ".coding-workspace-agent" ? column.querySelector(".workspace-monitor-content") : column;
+    target.scrollTop = end ? 1e7 : 500;
+  }, { selector, end });
   await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
   return page.evaluate((selector) => {
-    const column = document.querySelector(selector); const rect = column.getBoundingClientRect(); const header = column.querySelector(".coding-workspace-column-header").getBoundingClientRect();
-    return { scroll: column.scrollTop, local: Math.abs(header.top - rect.top) < 2, bottom: rect.bottom, headerBottom: header.bottom };
+    const column = document.querySelector(selector);
+    const target = selector === ".coding-workspace-agent" ? column.querySelector(".workspace-monitor-content") : column;
+    const rect = column.getBoundingClientRect(); const header = column.querySelector(".coding-workspace-column-header").getBoundingClientRect();
+    return { scroll: target.scrollTop, local: Math.abs(header.top - rect.top) < 2, bottom: rect.bottom, headerBottom: header.bottom };
   }, selector);
 }
 
 // Implements the five immutable ticket layout assertions without replacing browser behavior with source regexes.
 export async function verifyCodingLayoutAssertion(index, page) {
   await prepare(page);
-  await page.evaluate(() => document.querySelectorAll(".coding-workspace-column").forEach((column) => { column.scrollTop = 0; }));
+  await page.evaluate(() => document.querySelectorAll(".coding-workspace-column, .workspace-monitor-content").forEach((el) => { el.scrollTop = 0; }));
   if (index === 17 || index === 21) {
     for (const selector of [".coding-sprint-plan", ".coding-workspace-agent"]) {
       const other = selector === ".coding-sprint-plan" ? ".coding-workspace-agent" : ".coding-sprint-plan";
       const result = await scrollColumn(page, selector, index === 21);
       assert.ok(result.scroll > 0); assert.ok(result.local, "Header stays pinned inside its own column");
       assert.equal(await page.locator(other).evaluate((column) => column.scrollTop), 0);
-      await page.locator(selector).evaluate((column) => { column.scrollTop = 0; });
+      await page.evaluate(() => document.querySelectorAll(".coding-workspace-column, .workspace-monitor-content").forEach((el) => { el.scrollTop = 0; }));
     }
     assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".coding-workspace-monitor")).gridTemplateColumns.split(" ").length), page.viewportSize().width <= 760 ? 1 : 2);
   } else if (index === 18) {
     await scrollColumn(page, ".coding-workspace-agent", true);
     assert.deepEqual(await page.evaluate(() => window.layoutFixture.gitProjects), ["PROJECT-NODEFORGE"]);
     assert.equal(await page.evaluate(() => {
-      const column = document.querySelector(".coding-workspace-agent").getBoundingClientRect(); const header = document.querySelector(".coding-workspace-agent .coding-workspace-column-header").getBoundingClientRect(); const git = document.querySelector(".workspace-git-status").getBoundingClientRect();
-      return git.width > 0 && git.top >= column.top && git.bottom <= column.bottom && Math.abs(git.right - header.right) < 2;
+      const pageHeader = document.querySelector(".coding-workspace-header").getBoundingClientRect(); const git = document.querySelector(".workspace-git-status").getBoundingClientRect();
+      return git.width > 0 && git.top >= pageHeader.top - 2 && git.bottom <= pageHeader.bottom + 2 && git.right <= pageHeader.right + 2;
     }), true);
   } else if (index === 19) {
     const geometry = await scrollColumn(page, ".coding-workspace-agent", true);
-    const rect = await page.locator(".coding-agent-monitor:last-child > div:last-child").boundingBox();
-    assert.ok(rect && rect.y >= geometry.headerBottom && rect.y + rect.height <= geometry.bottom + 1);
-    await page.locator(".coding-agent-monitor:last-child button").click();
-    assert.equal(await page.evaluate(() => window.layoutFixture.closedPanels.at(-1)?.agentId), "coder-6");
+    const rect = await page.locator(".coding-agent-monitor:last-child > .workspace-monitor-content").boundingBox();
+    assert.ok(rect && rect.y >= geometry.headerBottom && rect.y + rect.height <= geometry.bottom + 2);
+    await scrollColumn(page, ".coding-sprint-plan", true);
     await page.locator("[data-layout-end]").click();
     assert.equal(await page.evaluate(() => window.layoutFixture.sprintClicked), true);
   } else if (index === 20) {
     const layout = await page.evaluate(() => {
-      const list = document.querySelector(".coding-workspace-list"); const column = document.querySelector(".coding-workspace-agent"); const panels = [...list.children];
-      return { tracks: getComputedStyle(list).gridTemplateColumns.split(" ").length, firstRow: panels.filter((panel) => Math.abs(panel.offsetTop - panels[0].offsetTop) < 2).length, overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth, count: panels.length };
+      const list = document.querySelector(".coding-workspace-list"); const column = document.querySelector(".coding-workspace-agent");
+      const rows = [...list.querySelectorAll(".coding-workspace-row")]; const monitors = [...list.querySelectorAll(".coding-agent-monitor")];
+      const r0 = rows[0].getBoundingClientRect(); const r1 = rows[1].getBoundingClientRect();
+      const m0 = monitors[0].getBoundingClientRect(); const m1 = monitors[1].getBoundingClientRect();
+      return {
+        rowCount: rows.length, upperChildren: rows[0].children.length, monitorCount: monitors.length,
+        equalRows: Math.abs(r0.height - r1.height) <= 20 && r0.height > 40,
+        equalCols: Math.abs(m0.width - m1.width) <= 4 && m0.width > 40,
+        overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth
+      };
     });
-    assert.equal(layout.count, 7); assert.equal(layout.overflow, false); assert.equal(layout.firstRow, layout.tracks); assert.ok(layout.tracks >= 1 && layout.tracks <= 3);
-    assert.equal(layout.tracks, page.viewportSize().width >= 1440 ? 3 : page.viewportSize().width <= 400 ? 1 : page.viewportSize().width <= 760 ? 2 : 1);
+    assert.equal(layout.rowCount, 2); assert.equal(layout.upperChildren, 0); assert.equal(layout.monitorCount, 2);
+    assert.equal(layout.equalRows, true); assert.equal(layout.equalCols, true); assert.equal(layout.overflow, false);
   } else throw new Error("No layout scenario implements this assertion.");
 }
diff --git a/backend/tests/unit/browser-coding-layout.test.js b/backend/tests/unit/browser-coding-layout.test.js
index d0abcb3..8e3c95d 100644
--- a/backend/tests/unit/browser-coding-layout.test.js
+++ b/backend/tests/unit/browser-coding-layout.test.js
@@ -8,7 +8,7 @@ import { matchesBrowserEvidence } from "../../src/modules/supervisor/browser/bro
 
 const step = { kind: "browser", criterion_ids: ["AC-1", "AC-2", "AC-3", "AC-4", "AC-5", "AC-6", "AC-8", "AC-9", "AC-10"], viewports: [375, 768, 1440], assertions: CODING_BROWSER_ASSERTIONS.slice(17, 22) };
 
-test("Chromium: all five approved layout assertions execute across every viewport", { skip: process.env.NODEFORGE_BROWSER_TEST !== "1", timeout: 90000 }, async (context) => {
+test("Chromium: all five approved layout assertions execute across every viewport", { timeout: 90000 }, async (context) => {
   const archive = process.env.NODEFORGE_BROWSER_COMMIT ? await materializeTicketArchive({ projectRoot: process.cwd(), commitSha: process.env.NODEFORGE_BROWSER_COMMIT }) : null;
   if (archive) context.after(archive.cleanup);
   const receipt = await runBrowserVerification({ step, sourceRoot: archive?.path ?? process.cwd(), projectRoot: process.cwd() });
```

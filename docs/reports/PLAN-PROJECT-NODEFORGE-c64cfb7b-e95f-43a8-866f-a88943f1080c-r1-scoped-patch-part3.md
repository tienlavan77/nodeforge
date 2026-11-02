<!--
Business purpose: Provides Part 3 of 5 of the complete, verbatim git diff between base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
Technical description: Generated directly from git diff 131a628f042a27f0098df3dfb62f03a1a50223b4..452c3c353b46c8f0b92841547177a49b46d77383 without manual hunk editing; bounded to <= 250 physical lines.
-->
# Scoped Unified Patch (Part 3/5: Unit & Route Tests) — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` | **Review Commit SHA**: `452c3c353b46c8f0b92841547177a49b46d77383` (`tree_sha: 89f1468c05c86d280b6e0dc60a1fe25079d25ff9`)
- **Manifest SHA-256**: `sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316` | **Files in Part 3**: `ui/nextjs/tests/coding-workspace-layout.test.js`, `ui/nextjs/tests/coding-agent-panel-registry.test.js`, `ui/nextjs/tests/conversations-navigation.test.js`
- **All Patch Parts**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (Part 1), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part2.md` (Part 2), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part3.md` (Part 3), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part4.md` (Part 4), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part5.md` (Part 5)

```diff
diff --git a/ui/nextjs/tests/coding-workspace-layout.test.js b/ui/nextjs/tests/coding-workspace-layout.test.js
index ee4e456..8f41d22 100644
--- a/ui/nextjs/tests/coding-workspace-layout.test.js
+++ b/ui/nextjs/tests/coding-workspace-layout.test.js
@@ -1,7 +1,8 @@
-// Prevents the sidebar-free Coding page from being squeezed into Home's 350px conversation track.
+// Prevents the sidebar-free Coding page from being squeezed into Home's 350px conversation track and verifies the 2-row Workspace Agent monitor layout.
 import assert from "node:assert/strict";
 import test from "node:test";
 import { readFile } from "node:fs/promises";
+import { resolveCodingAgentActivities, resolveCodingAgentTone } from "../lib/coding-workspace-activity.js";
 
 const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
 const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
@@ -45,21 +46,35 @@ test("Coding places a shared page header with project and Git status above both
   const wiring = page.match(/<CodingWorkspaceMonitor\b[^>]*\/>/)?.[0];
   assert.match(wiring, /\bprojectId\s*=\s*\{PROJECT_ID\}/);
   assert.match(wiring, /\bclient\s*=\s*\{client\}/);
+  assert.match(wiring, /\bwatcherState\s*=\s*\{watcherState\}/);
 });
 
-test("Coding agent list adapts to one, two or at most three columns without widening panels", () => {
-  assert.equal(declarations(".coding-workspace-list")["grid-template-columns"], "minmax(0, 1fr)");
-  assert.equal(declarations(".coding-workspace-agent")["container-type"], "inline-size");
-  for (const [width, columns] of [[490, 2], [740, 3]]) {
-    assert.match(styles, new RegExp(`@container\\s+coding-agents\\s*\\(min-width:\\s*${width}px\\)\\s*\\{\\s*\\.coding-workspace-list\\s*\\{[^}]*grid-template-columns:\\s*repeat\\(${columns},\\s*minmax\\(0,\\s*1fr\\)\\)`));
-  }
-  assert.doesNotMatch(styles, /grid-template-columns:\s*repeat\([4-9]/);
-  assert.equal(declarations(".coding-agent-monitor")["min-width"], "0");
-  assert.equal(declarations(".coding-agent-monitor header")["flex-wrap"], "wrap");
-  assert.equal(declarations(".coding-agent-monitor header > button")["flex-shrink"], "0");
+test("Coding Workspace Agent uses a 2-row equal grid without conflicting percentage height and two equal lower monitor columns", () => {
+  const agentCol = declarations(".coding-workspace-agent");
+  assert.equal(agentCol.display, "flex");
+  assert.equal(agentCol["flex-direction"], "column");
+  assert.equal(agentCol["container-type"], "inline-size");
+  const list = declarations(".coding-workspace-list");
+  assert.equal(list.display, "grid");
+  assert.equal(list.flex, "1");
+  assert.equal(list["min-height"], "0");
+  assert.equal(list["grid-template-columns"], "minmax(0, 1fr)");
+  assert.equal(list["grid-template-rows"], "minmax(0, 1fr) minmax(0, 1fr)");
+  const row = declarations(".coding-workspace-row");
+  assert.equal(row.display, "grid");
+  assert.equal(row["grid-template-columns"], "repeat(2, minmax(0, 1fr))");
+  assert.equal(row["min-height"], "0");
+  assert.equal(row.height, undefined);
+  const monitorCol = declarations(".coding-workspace-monitor-column");
+  assert.equal(monitorCol.display, "flex");
+  assert.equal(monitorCol["flex-direction"], "column");
+  assert.equal(monitorCol["min-width"], "0");
+  assert.equal(monitorCol["min-height"], "0");
+  assert.equal(monitorCol.overflow, "hidden");
+  assert.doesNotMatch(monitor, /workspace-monitor-dock/);
 });
 
-test("Only Coding monitor chrome loses padding while panels cap height with scrolling content", () => {
+test("Only Coding monitor chrome loses padding while monitor content scrolls inside bounded columns", () => {
   assert.equal(declarations(".workspace-monitor-header").padding, "0 10px 0 14px");
   assert.equal(declarations(".workspace-monitor-header").flex, "none");
   assert.equal(declarations(".coding-agent-monitor .workspace-monitor-header").padding, "0");
@@ -71,18 +86,21 @@ test("Only Coding monitor chrome loses padding while panels cap height with scro
   const panel = declarations(".coding-agent-monitor");
   assert.equal(panel.display, "flex");
   assert.equal(panel["flex-direction"], "column");
-  assert.equal(panel["max-height"], "50vh");
   assert.equal(panel["box-sizing"], "border-box");
   assert.equal(panel.overflow, "hidden");
 });
 
-test("Coding restores navigation before the workspace without conversation controls", () => {
+test("Coding restores navigation before the workspace without conversation controls and resets realtime monitor state on project switch", () => {
   assert.match(page, /className="claude-home-shell coding-workspace-shell"/);
   assert.ok(page.indexOf("<ConversationSidebar") < page.indexOf("<CodingWorkspaceMonitor"));
   assert.match(page, /showConversationControls=\{false\}/);
   assert.match(page, /open=\{openSidebar\} onOpen=\{\(\) => setOpenSidebar\(true\)\} onClose=\{\(\) => setOpenSidebar\(false\)\}/);
+  assert.match(page, /setAgentActivities\(\[\]\)/);
+  assert.match(page, /setWatcherEvents\(\[\]\)/);
+  assert.match(page, /setWatcherPulseId\(null\)/);
+  assert.match(page, /setWatcherState\("connecting"\)/);
   assert.match(styles, /\.claude-home-shell\.coding-workspace-shell[^{]*\{[^}]*grid-template-columns:\s*350px minmax\(0, 1fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
-  assert.ok(globals.indexOf('styles/workspace-monitors.css') > globals.indexOf('styles/home-workspace.css'));
+  assert.ok(globals.indexOf("styles/workspace-monitors.css") > globals.indexOf("styles/home-workspace.css"));
 });
 
 test("Coding fills the viewport and keeps scrollable columns without changing Home or the internal split", () => {
@@ -97,3 +115,58 @@ test("Coding fills the viewport and keeps scrollable columns without changing Ho
   assert.match(styles, /coding-workspace-shell \.conversation-mobile-rail[^{]*\{[^}]*display:\s*flex;[^}]*top:\s*0/);
   assert.match(styles, /@media \(min-width: 641px\)[\s\S]*?responsive-region--conversations[^{]*\{[^}]*position:\s*static/);
 });
+
+test("Unified Agents Activity resolver formats multiple agents, missing optional fields, deterministic tones, and project isolation", () => {
+  const directory = [
+    { agent_id: "coder-1", agent_name: "Alpha Coder", role: "coder", project_id: "PROJ-A" },
+    { agent_id: "reviewer-1", name: "Beta Reviewer", role: "reviewer", project_id: "PROJ-A" },
+    { agent_id: "leader-1", label: "Sprint Lead", role: "sprint_leader", project_id: "PROJ-A" }
+  ];
+  const activities = [
+    { event_id: "ev-1", event_type: "agent.activity", project_id: "PROJ-A", timestamp: "2026-11-02T10:00:00.000Z", payload: { agent_id: "coder-1", activity_type: "tool_started", status: "working", summary: "Inspecting layout", tool_name: "read_file" } },
+    { event_id: "ev-2", event_type: "agent.activity", project_id: "PROJ-A", payload: { agent_id: "reviewer-1", tool_name: "search_text" } },
+    { event_id: "ev-foreign", event_type: "agent.activity", project_id: "PROJ-B", payload: { agent_id: "coder-1", summary: "Foreign project" } }
+  ];
+  const resolved = resolveCodingAgentActivities(activities, directory, "PROJ-A");
+  assert.equal(resolved.length, 2);
+  assert.equal(resolved[0].agentName, "Alpha Coder");
+  assert.equal(resolved[0].activityType, "tool started");
+  assert.equal(resolved[0].status, "working");
+  assert.equal(resolved[0].detail, "Inspecting layout (read_file)");
+  assert.ok(resolved[0].time.length > 0);
+  assert.equal(resolved[1].agentName, "Beta Reviewer");
+  assert.equal(resolved[1].activityType, "activity");
+  assert.equal(resolved[1].status, "working");
+  assert.equal(resolved[1].detail, "search_text");
+  assert.equal(resolved[0].tone, resolveCodingAgentTone("coder-1"));
+  assert.equal(resolveCodingAgentTone("coder-1"), resolveCodingAgentTone("coder-1"));
+  assert.equal(resolveCodingAgentTone("coder-1", "#7ee787"), "#7ee787");
+  assert.equal(resolveCodingAgentTone("coder-1", "transparent"), resolveCodingAgentTone("coder-1"));
+  assert.equal(resolveCodingAgentTone("coder-1", "#123456"), resolveCodingAgentTone("coder-1"));
+  assert.equal(resolveCodingAgentTone("coder-1", "rgba(0, 0, 0, 0)"), resolveCodingAgentTone("coder-1"));
+  const conflicting = resolveCodingAgentActivities([
+    { event_id: "C-1", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "transparent", payload: { agent_id: "coder-1", summary: "First step", agent_color: "#000000" } },
+    { event_id: "C-2", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#ffcb6b", payload: { agent_id: "coder-1", summary: "Second step", agent_color: "#89ddff" } },
+    { event_id: "C-3", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#f07178", payload: { agent_id: "coder-1", summary: "Third step" } }
+  ], directory, "PROJ-A");
+  assert.equal(conflicting.length, 3);
+  assert.equal(conflicting[0].tone, resolveCodingAgentTone("coder-1"));
+  assert.equal(conflicting[1].tone, conflicting[0].tone);
+  assert.equal(conflicting[2].tone, conflicting[0].tone);
+
+  const rollingBuffer = [
+    { event_id: "R-1", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#ffcb6b", payload: { agent_id: "coder-1", summary: "Oldest event", agent_color: "#ffcb6b" } },
+    { event_id: "R-2", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#89ddff", payload: { agent_id: "coder-1", summary: "Newer event", agent_color: "#89ddff" } }
+  ];
+  const beforeEviction = resolveCodingAgentActivities(rollingBuffer, directory, "PROJ-A");
+  const afterEviction = resolveCodingAgentActivities(rollingBuffer.slice(1), directory, "PROJ-A");
+  assert.equal(beforeEviction.length, 2);
+  assert.equal(afterEviction.length, 1);
+  assert.equal(beforeEviction[0].tone, resolveCodingAgentTone("coder-1"));
+  assert.equal(beforeEviction[1].tone, beforeEviction[0].tone);
+  assert.equal(afterEviction[0].tone, beforeEviction[1].tone);
+
+  const profiledDirectory = [{ agent_id: "coder-1", project_id: "PROJ-A", role: "coder", agent_name: "Coder One", color: "#ffcb6b" }];
+  assert.equal(resolveCodingAgentActivities(rollingBuffer, profiledDirectory, "PROJ-A")[0].tone, "#ffcb6b");
+  assert.equal(resolveCodingAgentActivities(rollingBuffer.slice(1), profiledDirectory, "PROJ-A")[0].tone, "#ffcb6b");
+});
diff --git a/ui/nextjs/tests/coding-agent-panel-registry.test.js b/ui/nextjs/tests/coding-agent-panel-registry.test.js
index 1ee0ecc..afeeff2 100644
--- a/ui/nextjs/tests/coding-agent-panel-registry.test.js
+++ b/ui/nextjs/tests/coding-agent-panel-registry.test.js
@@ -230,36 +230,22 @@ test("AC-10: Sprint Plan component contracts and Coding ingress wiring remain in
     assert.ok(tag);
     for (const attribute of attributes) assert.ok(tag.replace(/\s/g, "").includes(attribute.replace(/\s/g, "")));
   }
-  assert.match(monitor, /key\s*=\s*\{panel\.key\}/);
   assert.match(page, /planEvents\.publish\(event\)/);
   assert.match(page, /updateCodingAgentPanelRegistry\(current,\s*PROJECT_ID,\s*\[event\]/);
   assert.match(page, /setWatcherState\s*:\s*setPanelSource/);
-  const closeControl = monitor.match(/<button\b[\s\S]*?>\s*×\s*<\/button>/)?.[0];
-  assert.ok(closeControl);
-  assert.match(closeControl, /type\s*=\s*"button"/);
-  assert.match(closeControl, /aria-label\s*=\s*\{`Close agent panel \$\{panel\.agentId\} in project \$\{panel\.projectId\}`\}/);
-  assert.match(closeControl, /onAgentPanelClose\?\.\(panel\.projectId,\s*panel\.agentId\)/);
-  assert.match(page, /closeCodingAgentPanel\(current,\s*projectId,\s*agentId\)/);
-  assert.match(page, /onAgentPanelClose\s*=\s*\{onAgentPanelClose\}/);
+  assert.match(page, /setWatcherState\(status\)/);
+  assert.match(page, /watcherState=\{watcherState\}/);
 });
 
-test("AC-16: the monitor reuses System panel chrome and exposes a dock that opens a panel by exact agent identity", async () => {
+test("AC-16: the monitor reuses System panel chrome for unified Agents Activity and Watcher monitors without individual agent panels or dock", async () => {
   const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");
-  const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
-  // Same floating-panel design tokens used by the System workspace monitors.
-  assert.match(monitor, /className=\{`coding-agent-monitor\$\{minimized \? " is-minimized" : ""\}`\}/);
+  assert.match(monitor, /className="coding-workspace-monitor-column coding-agent-monitor"/);
   assert.match(monitor, /className="workspace-monitor-header"/);
   assert.match(monitor, /className="workspace-monitor-content"/);
   assert.match(monitor, /workspace-monitor-light/);
   assert.match(monitor, /workspace-monitor-indicator/);
-  assert.match(monitor, /<div className="workspace-monitor-dock" role="group"/);
-  // Dock entries open the panel for the exact agent ID of a currently working, validated identity.
-  const dockButton = monitor.match(/<button key=\{key\}[\s\S]*?<\/button>/)?.[0];
-  assert.ok(dockButton);
-  assert.match(dockButton, /aria-pressed=\{openKeys\.has\(key\)\}/);
-  assert.match(dockButton, /onAgentPanelOpen\?\.\(projectId, agentId\)/);
-  assert.match(monitor, /status === "working"[\s\S]*codingAgentProfile\(agentDirectory, identity\.agentId, projectId\)/);
-  assert.match(page, /openCodingAgentPanel\(current, projectId, agentId, agentDirectoryRef\.current\)/);
-  assert.match(page, /onAgentPanelOpen=\{onAgentPanelOpen\}/);
+  assert.doesNotMatch(monitor, /workspace-monitor-dock/);
+  assert.match(monitor, /<h3>Agents Activity<\/h3>/);
+  assert.match(monitor, /<h3>Watcher<\/h3>/);
 });
 
diff --git a/ui/nextjs/tests/conversations-navigation.test.js b/ui/nextjs/tests/conversations-navigation.test.js
index e691268..731dde1 100644
--- a/ui/nextjs/tests/conversations-navigation.test.js
+++ b/ui/nextjs/tests/conversations-navigation.test.js
@@ -45,8 +45,8 @@ test("home route composes the conversation workspace from existing components",
   assert.ok(systemPage.includes("setAgentProcess"));
   assert.ok(codingMonitor.includes('<h1 id="coding-sprint-plan-heading">Sprint Plan</h1>'));
   assert.ok(codingMonitor.includes('<h1 id="coding-workspace-agent-heading">Workspace Agent</h1>'));
-  assert.match(codingMonitor, /codingAgentPanelActions\(agentActivities,\s*agentDirectory,\s*projectId,\s*panel\.agentId\)/);
-  assert.match(legacyCodePage, /agentPanelRegistry\s*=\s*\{agentPanelRegistry\}/);
+  assert.match(codingMonitor, /resolveCodingAgentActivities\(agentActivities,\s*agentDirectory,\s*projectId\)/);
+  assert.match(legacyCodePage, /watcherState\s*=\s*\{watcherState\}/);
   assert.ok(codingMonitor.includes('import { SprintPlanDashboard } from "./sprint-plan-panels.jsx"'));
   assert.ok(codingMonitor.includes("<SprintPlanDashboard dashboard={dashboard}"));
   assert.ok(legacyCodePage.includes("createCodingDashboardLoader"));
```

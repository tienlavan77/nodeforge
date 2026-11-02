<!--
Business purpose: Provides Part 4 of 5 of the complete, verbatim git diff between base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
Technical description: Generated directly from git diff 131a628f042a27f0098df3dfb62f03a1a50223b4..452c3c353b46c8f0b92841547177a49b46d77383 without manual hunk editing; bounded to <= 250 physical lines.
-->
# Scoped Unified Patch (Part 4/5: Browser Integration Test (Lines 1-150)) — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` | **Review Commit SHA**: `452c3c353b46c8f0b92841547177a49b46d77383` (`tree_sha: 89f1468c05c86d280b6e0dc60a1fe25079d25ff9`)
- **Manifest SHA-256**: `sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316` | **Files in Part 4**: `ui/nextjs/tests/coding-workspace-layout-browser.test.js` (diff lines 1–150)
- **All Patch Parts**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (Part 1), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part2.md` (Part 2), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part3.md` (Part 3), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part4.md` (Part 4), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part5.md` (Part 5)

```diff
diff --git a/ui/nextjs/tests/coding-workspace-layout-browser.test.js b/ui/nextjs/tests/coding-workspace-layout-browser.test.js
index b6ea758..86804ef 100644
--- a/ui/nextjs/tests/coding-workspace-layout-browser.test.js
+++ b/ui/nextjs/tests/coding-workspace-layout-browser.test.js
@@ -1,4 +1,4 @@
-// Verify Coding's pinned headers and bounded agent grid with real Chromium scrolling and controls.
+// Verify Coding's pinned headers, 2-row Workspace Agent layout, unified monitors, realtime events, project switching, and internal scrolling in Chromium.
 import assert from "node:assert/strict";
 import test from "node:test";
 import { createServer } from "node:http";
@@ -7,7 +7,7 @@ import { join } from "node:path";
 import { build } from "esbuild";
 import { launchProjectChromium } from "../../../backend/tests/helpers/chromium-cdp.js";
 
-// Measure actual rendered tracks, overflow and control visibility without mocking layout.
+// Measure actual rendered rows, columns, overflow, and monitor scrolling without mocking layout.
 const measure = `(() => {
   const monitor = document.querySelector('.coding-workspace-monitor');
   const pageHeader = monitor.querySelector('.coding-workspace-header');
@@ -21,40 +21,140 @@ const measure = `(() => {
   const pageHeaderRect = pageHeader.getBoundingClientRect();
   const gitRect = git.getBoundingClientRect();
   const headerRect = header.getBoundingClientRect();
-  const panels = [...list.children];
+  const rows = [...list.querySelectorAll('.coding-workspace-row')];
+  const monitors = [...list.querySelectorAll('.coding-workspace-monitor-column')];
+  const contents = monitors.map(m => m.querySelector('.workspace-monitor-content'));
+  const row0Rect = rows[0].getBoundingClientRect();
+  const row1Rect = rows[1].getBoundingClientRect();
+  const mon0Rect = monitors[0].getBoundingClientRect();
+  const mon1Rect = monitors[1].getBoundingClientRect();
   return {
-    tracks: getComputedStyle(list).gridTemplateColumns.split(' ').length,
     monitorTracks: getComputedStyle(monitor).gridTemplateColumns.split(' ').length,
-    firstRow: panels.filter(panel => Math.abs(panel.offsetTop - panels[0].offsetTop) < 2).length,
+    rowCount: rows.length,
+    upperRowChildren: rows[0].children.length,
+    monitorCount: monitors.length,
+    equalRows: Math.abs(row0Rect.height - row1Rect.height) <= 20 && row0Rect.height > 40 && row1Rect.height > 40,
+    equalMonitorCols: Math.abs(mon0Rect.width - mon1Rect.width) <= 4 && mon0Rect.width > 40,
     overflow: column.scrollWidth > column.clientWidth || document.documentElement.scrollWidth > innerWidth,
-    vertical: column.scrollHeight > column.clientHeight,
+    sprintScrollable: sprintCol.scrollHeight > sprintCol.clientHeight,
+    activityScrollable: contents[0].scrollHeight > contents[0].clientHeight,
+    watcherScrollable: contents[1].scrollHeight > contents[1].clientHeight,
     headerTop: headerRect.top, columnTop: rect.top,
     pageHeaderAboveBoth: pageHeaderRect.bottom <= sprintRect.top + 4 && pageHeaderRect.bottom <= rect.top + 4,
     gitCountInColumnHeader: header.querySelectorAll('.workspace-git-status').length,
     gitVisible: gitRect.top >= pageHeaderRect.top && gitRect.bottom <= pageHeaderRect.bottom && gitRect.right <= pageHeaderRect.right,
     gitRight: gitRect.left > pageHeader.querySelector('h1').getBoundingClientRect().right,
-    panelCount: panels.length,
-    scrollTop: column.scrollTop,
     mainScroll: monitor.scrollTop,
     pageScroll: scrollY
   };
 })()`;
 
-test("Coding headers stay column-local beneath the shared page header and the agent list fits one, two and three tracks", { timeout: 60000 }, async (context) => {
+test("Coding headers stay column-local beneath the shared page header and Workspace Agent renders 2 equal rows with unified scrolling monitors and project isolation", { timeout: 60000 }, async (context) => {
   await mkdir(join(process.cwd(), ".forge/runtime"), { recursive: true });
   const directory = await mkdtemp(join(process.cwd(), ".forge/runtime/coding-layout-"));
   context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }));
-  const compiled = await build({ stdin: { contents: `
-    import {createRoot} from 'react-dom/client';
-    import {CodingWorkspaceMonitor} from './components/coding-workspace-monitor.jsx';
-    import {PROJECT_ID} from './lib/home-page-constants.js';
-    window.gitProjects=[]; window.closedPanels=[];
-    const client={getGitStatus:async(projectId)=>{window.gitProjects.push(projectId);return null},listPlans:async()=>[],listPlanRequests:async()=>[]};
-    const panels=Array.from({length:7},(_,index)=>({key:'panel-'+index,agentId:'coder-'+index,projectId:PROJECT_ID}));
-    const agents=panels.map(panel=>({agent_id:panel.agentId,project_id:PROJECT_ID,role:'coder',name:panel.agentId,status:'idle'}));
-    const activities=panels.flatMap(panel=>Array.from({length:30},(_,index)=>({event_type:'agent.activity',project_id:PROJECT_ID,payload:{agent_id:panel.agentId,summary:'Activity '+index+' '+ 'Long workspace activity content '.repeat(8),tool_name:'read_file'}})));
-    createRoot(document.getElementById('root')).render(<div className="claude-home-shell coding-workspace-shell"><aside className="conversation-sidebar is-collapsed"/><CodingWorkspaceMonitor projectId={PROJECT_ID} client={client} agentPanelRegistry={{panels,activity:{},sourceStatus:'connected'}} agentDirectory={agents} agentActivities={activities} onAgentPanelClose={(projectId,agentId)=>window.closedPanels.push({projectId,agentId})}/></div>);
-  `, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" }, bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser" });
+  const compiled = await build({
+    stdin: { contents: `
+      import { useState } from 'react';
+      import { createRoot } from 'react-dom/client';
+      import CodingPage from './app/coding/page.jsx';
+      import { PROJECT_ID } from './lib/home-page-constants.js';
+      window.gitProjects = [];
+      window.streamCalls = [];
+      function Harness() {
+        const [projectId, setProjectId] = useState(PROJECT_ID);
+        window.setCodingProject = setProjectId;
+        return <CodingPage projectId={projectId} />;
+      }
+      createRoot(document.getElementById('root')).render(<Harness />);
+    `, resolveDir: join(process.cwd(), "ui/nextjs"), loader: "jsx" },
+    bundle: true, jsx: "automatic", write: false, format: "iife", platform: "browser",
+    plugins: [{
+      name: "coding-page-browser-mocks",
+      // Business purpose: Provides a controlled local control-API and navigation boundary so the browser test mounts the real CodingPage and useProjectEventStream without external network dependencies.
+      // Technical description: Intercepts next/navigation, conversation-sidebar, and node-client imports during esbuild bundling while keeping CodingPage, useProjectEventStream, applyWatcherEvent, and CodingWorkspaceMonitor intact.
+      setup(builder) {
+        builder.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: "next-nav", namespace: "mock" }));
+        builder.onLoad({ filter: /^next-nav$/, namespace: "mock" }, () => ({ contents: "export const useParams = () => ({}); export const usePathname = () => '/coding';", loader: "js" }));
+        builder.onResolve({ filter: /conversation-sidebar\.jsx$/ }, () => ({ path: "sidebar", namespace: "mock" }));
+        builder.onLoad({ filter: /^sidebar$/, namespace: "mock" }, () => ({ contents: "export function ConversationSidebar() { return <aside className='conversation-sidebar is-collapsed' />; }", loader: "jsx", resolveDir: join(process.cwd(), "ui/nextjs") }));
+        builder.onResolve({ filter: /\/node-client\.js$/ }, () => ({ path: "node-client", namespace: "mock" }));
+        builder.onLoad({ filter: /^node-client$/, namespace: "mock" }, () => ({
+          contents: `
+            export function createNodeClient(projectId) {
+              const agents = [
+                { agent_id: 'coder-1', project_id: projectId, role: 'coder', agent_name: 'Coder One', status: 'idle' },
+                { agent_id: 'reviewer-1', project_id: projectId, role: 'reviewer', agent_name: 'Reviewer One', status: 'idle' },
+                { agent_id: 'leader-1', project_id: projectId, role: 'sprint_leader', agent_name: 'Sprint Leader', status: 'idle' }
+              ];
+              return {
+                getAgents: async () => agents,
+                getGitStatus: async (pid) => { window.gitProjects.push(pid ?? projectId); return null; },
+                getProjectDashboard: async () => ({ project_id: projectId, roadmap: { sprints: [] } }),
+                listPlans: async () => [],
+                listPlanRequests: async () => [],
+                listCodeCheckpoints: async () => ({ checkpoints: [] }),
+                connectProjectStream: (opts) => {
+                  window.activeStream = opts;
+                  window.streamCalls.push(opts.projectId);
+                  setTimeout(() => {
+                    if (window.activeStream !== opts) return;
+                    opts.onOpen?.();
+                    window.streamOpened = opts.projectId;
+                    if (opts.projectId === 'PROJECT-NODEFORGE') {
+                      for (let index = 0; index < 30; index += 1) {
+                        opts.onEvent?.({
+                          event_id: 'act-' + index,
+                          event_type: 'agent.activity',
+                          project_id: opts.projectId,
+                          timestamp: '2026-11-02T10:00:00.000Z',
+                          agent_color: index === 0 ? '#ffcb6b' : index % 2 === 0 ? '#89ddff' : '#000000',
+                          payload: {
+                            agent_id: index % 2 === 0 ? 'coder-1' : 'reviewer-1',
+                            activity_type: 'tool_started',
+                            status: 'working',
+                            agent_color: index === 0 ? '#ffcb6b' : index === 2 ? '#89ddff' : 'transparent',
+                            summary: 'Activity ' + index + ' ' + 'Long workspace activity content '.repeat(4),
+                            tool_name: 'read_file'
+                          }
+                        });
+                      }
+                      opts.onEvent?.({
+                        event_id: 'wat-snap',
+                        event_type: 'stream.snapshot',
+                        project_id: opts.projectId,
+                        timestamp: '2026-11-02T10:01:00.000Z',
+                        payload: {
+                          watcher: {
+                            recent_events: [0, 1, 2].map((idx) => ({
+                              event_id: 'wat-' + idx,
+                              event_type: idx % 2 === 0 ? 'watcher.file_indexed' : 'watcher.file_removed',
+                              project_id: opts.projectId,
```

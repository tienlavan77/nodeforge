<!--
Business purpose: Provides Part 1 of 5 of the complete, verbatim git diff between base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 and review commit 452c3c353b46c8f0b92841547177a49b46d77383 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1).
Technical description: Generated directly from git diff 131a628f042a27f0098df3dfb62f03a1a50223b4..452c3c353b46c8f0b92841547177a49b46d77383 without manual hunk editing; bounded to <= 250 physical lines.
-->
# Scoped Unified Patch (Part 1/5: CodingPage & CodingWorkspaceMonitor) — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` | **Review Commit SHA**: `452c3c353b46c8f0b92841547177a49b46d77383` (`tree_sha: 89f1468c05c86d280b6e0dc60a1fe25079d25ff9`)
- **Manifest SHA-256**: `sha256:ab16b7dc1dbf31159ec783c18d513a1bae0f856cbea6b49c5eb8892a2e2b1316` | **Files in Part 1**: `ui/nextjs/app/coding/page.jsx`, `ui/nextjs/components/coding-workspace-monitor.jsx`
- **All Patch Parts**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch.md` (Part 1), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part2.md` (Part 2), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part3.md` (Part 3), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part4.md` (Part 4), `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-scoped-patch-part5.md` (Part 5)

```diff
diff --git a/ui/nextjs/app/coding/page.jsx b/ui/nextjs/app/coding/page.jsx
index b991fba..bee1f1c 100644
--- a/ui/nextjs/app/coding/page.jsx
+++ b/ui/nextjs/app/coding/page.jsx
@@ -52,10 +52,17 @@ export default function CodingPage({ projectId: propProjectId } = {}) {
   const restoredPanelMembershipRef = useRef(null);
   const panelsHydratedRef = useRef(false);
 
+  const [watcherEvents, setWatcherEvents] = useState([]);
+  const [watcherPulseId, setWatcherPulseId] = useState(null);
+  const [watcherState, setWatcherState] = useState("connecting");
+
   // Restore saved open/closed presence once before defaults or live run evidence are processed.
   useEffect(() => {
     panelsHydratedRef.current = false;
     setAgentActivities([]);
+    setWatcherEvents([]);
+    setWatcherPulseId(null);
+    setWatcherState("connecting");
     restoredPanelMembershipRef.current = readCodingAgentPanelMembership(panelStateStorage, PROJECT_ID,
       (error) => console.error("Unable to read coding panel presence", error));
     setAgentPanelRegistry((current) => hydrateCodingAgentPanelRegistry(current, restoredPanelMembershipRef.current, agentDirectoryRef.current));
@@ -68,6 +75,7 @@ export default function CodingPage({ projectId: propProjectId } = {}) {
   }, [planEvents, PROJECT_ID]);
   // Invalidate cached execution claims whenever the live source connects or disconnects.
   const setPanelSource = useCallback((status) => {
+    setWatcherState(status);
     setAgentPanelRegistry((current) => setCodingAgentPanelSource(current, status));
   }, []);
   useEffect(() => {
@@ -94,16 +102,6 @@ export default function CodingPage({ projectId: propProjectId } = {}) {
   // Write the latest membership before unmount so navigation preserves the final open/closed set.
   useEffect(() => () => panelPersister.flush(), [panelPersister]);
 
-  // Close only the selected project/agent panel while preserving its same-run closure policy.
-  const onAgentPanelClose = useCallback((projectId, agentId) => {
-    setAgentPanelRegistry((current) => closeCodingAgentPanel(current, projectId, agentId));
-  }, []);
-
-  // Open the panel for the selected working agent from the dock, bypassing streamed evidence for this explicit action.
-  const onAgentPanelOpen = useCallback((projectId, agentId) => {
-    setAgentPanelRegistry((current) => openCodingAgentPanel(current, projectId, agentId, agentDirectoryRef.current));
-  }, []);
-
   // Refresh Registry Sprint scope while preserving structured diagnostics for the active page.
   const loadWorkspaceMonitor = useCallback((options) => dashboardLoader.load(options), [dashboardLoader]);
   // Apply a confirmed Sprint deletion locally instead of resetting the entire Coding dashboard.
@@ -113,7 +111,7 @@ export default function CodingPage({ projectId: propProjectId } = {}) {
 
   useProjectEventStream({
     client, projectId: PROJECT_ID, activeConversationIdRef, agentDirectoryRef,
-    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents: () => {}, setWatcherPulseId: () => {}, setWatcherState: setPanelSource,
+    setMessages: () => {}, setAgentTyping: () => {}, setWatcherEvents, setWatcherPulseId, setWatcherState: setPanelSource,
     setAgentProcess: () => {}, setAgentActivities, loadDashboard: loadWorkspaceMonitor, onSprintDeleted, onTicketDeleted, onProjectEvent, agentDisplayName
   });
 
@@ -130,6 +128,6 @@ export default function CodingPage({ projectId: propProjectId } = {}) {
 
   return <div className="claude-home-shell coding-workspace-shell" data-project-id={PROJECT_ID}>
     <ConversationSidebar open={openSidebar} onOpen={() => setOpenSidebar(true)} onClose={() => setOpenSidebar(false)} agentSectionTitle="Code" selectedProjectId={PROJECT_ID} showConversationControls={false} />
-    <CodingWorkspaceMonitor planEvents={planEvents} projectId={PROJECT_ID} dashboard={dashboardState.dashboard} dashboardState={dashboardState} client={client} onRefresh={loadWorkspaceMonitor} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} agentActivities={agentActivities} agentDirectory={agents} agentPanelRegistry={agentPanelRegistry} onAgentPanelClose={onAgentPanelClose} onAgentPanelOpen={onAgentPanelOpen} />
+    <CodingWorkspaceMonitor planEvents={planEvents} projectId={PROJECT_ID} dashboard={dashboardState.dashboard} dashboardState={dashboardState} client={client} onRefresh={loadWorkspaceMonitor} onSprintDeleted={onSprintDeleted} onTicketDeleted={onTicketDeleted} agentActivities={agentActivities} agentDirectory={agents} watcherEvents={watcherEvents} watcherPulseId={watcherPulseId} watcherState={watcherState} />
   </div>;
 }
diff --git a/ui/nextjs/components/coding-workspace-monitor.jsx b/ui/nextjs/components/coding-workspace-monitor.jsx
index fbb5e1b..e54176a 100644
--- a/ui/nextjs/components/coding-workspace-monitor.jsx
+++ b/ui/nextjs/components/coding-workspace-monitor.jsx
@@ -1,8 +1,9 @@
-// Present the legacy Sprint Plan controls beside active Coder and Reviewer work in Coding.
+// Present the legacy Sprint Plan controls beside unified Coding workspace monitors.
 "use client";
 
-import { useState } from "react";
-import { codingAgentPanelKey, codingAgentProfile, codingAgentPanelActions, codingAgentPanelStatus } from "../lib/coding-agent-panel-registry.js";
+import { useEffect, useState } from "react";
+import { displayMessageTime } from "../lib/home-page-watcher-events.js";
+import { resolveCodingAgentActivities, resolveCodingAgentTone } from "../lib/coding-workspace-activity.js";
 // eslint-disable-next-line no-unused-vars -- Next resolves these component references in JSX.
 import { SprintPlanDashboard } from "./sprint-plan-panels.jsx";
 // eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
@@ -12,15 +13,43 @@ import { CodingArchitecturePlans } from "./coding-architecture-plans.jsx";
 // eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
 import { ConversationHeaderProjectGit } from "./conversation-project-git.jsx";
 
-// Render the legacy Sprint Plan experience alongside active Coding workspace agents.
-export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashboardState, client, onRefresh, onSprintDeleted, onTicketDeleted, agentActivities = [], agentDirectory = [], onAgentPanelClose, onAgentPanelOpen, agentPanelRegistry = { panels: [], activity: {}, sourceStatus: "unknown" } }) {
-  const panels = agentPanelRegistry.panels.filter((panel) => panel.projectId === projectId);
-  const [minimizedPanels, setMinimizedPanels] = useState({});
-  const openKeys = new Set(panels.map((panel) => panel.key));
-  // Dock entries follow live working evidence for validated identities in this project only, never labels or roles.
-  const workingAgents = Object.entries(agentPanelRegistry.activity ?? {})
-    .flatMap(([key, status]) => status === "working" ? [codingPanelIdentity(key)] : [])
-    .filter((identity) => identity?.projectId === projectId && codingAgentProfile(agentDirectory, identity.agentId, projectId));
+export { resolveCodingAgentActivities, resolveCodingAgentTone };
+
+// Render the legacy Sprint Plan experience alongside unified Coding workspace monitors.
+export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashboardState, client, onRefresh, onSprintDeleted, onTicketDeleted, agentActivities = [], agentDirectory = [], watcherEvents = [], watcherPulseId = null, watcherState = "connecting" }) {
+  const [watcherActive, setWatcherActive] = useState(false);
+  const [agentActive, setAgentActive] = useState(false);
+  const visibleActivities = resolveCodingAgentActivities(agentActivities, agentDirectory, projectId);
+  const scopedWatcherEvents = (Array.isArray(watcherEvents) ? watcherEvents : []).filter((event) => !projectId || !event?.project_id || event.project_id === projectId);
+  const watcherItems = scopedWatcherEvents.slice().reverse().flatMap((event, eventIndex) => {
+    const activities = Array.isArray(event?.payload?.activity) ? event.payload.activity : (event?.message ? [event.message] : []);
+    const label = event?.event_type === "watcher.file_removed" ? "Removed" : event?.event_type === "watcher.file_indexed" ? "Indexed" : (event?.timestamp ? displayMessageTime(event.timestamp) : "Watcher");
+    const time = displayMessageTime(event?.timestamp);
+    return activities.map((activity, activityIndex) => ({
+      key: `${event?.event_id ?? event?.timestamp ?? eventIndex}-${eventIndex}-${activityIndex}`,
+      meta: time && label !== time ? `${label} · ${time}` : label,
+      text: typeof activity === "string" ? activity : activity?.path ?? activity?.file_path ?? activity?.summary ?? JSON.stringify(activity)
+    }));
+  });
+  const watcherStatus = watcherState === "connected" ? "Connected" : watcherState === "error" || watcherState === "disconnected" ? "Disconnected" : "Reconnecting";
+  const indicatorClass = watcherState === "connected" ? "is-connected" : watcherState === "error" || watcherState === "disconnected" ? "is-error" : "is-connecting";
+
+  useEffect(() => {
+    const latest = scopedWatcherEvents.at(-1);
+    if (watcherState !== "connected" || (!watcherPulseId && (!latest?.timestamp || Date.now() - Date.parse(latest.timestamp) > 3000))) { setWatcherActive(false); return undefined; }
+    setWatcherActive(true);
+    const timeout = typeof window !== "undefined" ? window.setTimeout(() => setWatcherActive(false), 3000) : null;
+    return () => { if (timeout) window.clearTimeout(timeout); };
+  }, [watcherState, watcherPulseId, scopedWatcherEvents.length]);
+
+  useEffect(() => {
+    const latest = visibleActivities.at(-1);
+    if (!latest) { setAgentActive(false); return undefined; }
+    setAgentActive(true);
+    const timeout = typeof window !== "undefined" ? window.setTimeout(() => setAgentActive(false), 3000) : null;
+    return () => { if (timeout) window.clearTimeout(timeout); };
+  }, [visibleActivities.length]);
+
   return <main className="coding-workspace-monitor" aria-label="Coding workspace monitor">
     <header className="claude-chat-header coding-workspace-header"><h1>Coding</h1><ConversationHeaderProjectGit client={client} projectId={projectId} /></header>
     <section className="coding-workspace-column coding-sprint-plan" aria-labelledby="coding-sprint-plan-heading">
@@ -31,44 +60,24 @@ export function CodingWorkspaceMonitor({ planEvents, projectId, dashboard, dashb
       </CodingSprintDashboardState>
     </section>
     <section className="coding-workspace-column coding-workspace-agent" aria-labelledby="coding-workspace-agent-heading">
-      <header className="coding-workspace-column-header">
-        <h1 id="coding-workspace-agent-heading">Workspace Agent</h1>
-      </header>
+      <header className="coding-workspace-column-header"><h1 id="coding-workspace-agent-heading">Workspace Agent</h1></header>
       <div className="coding-workspace-list">
-        {panels.map((panel) => {
-          const profile = codingAgentProfile(agentDirectory, panel.agentId, projectId);
-          const actions = codingAgentPanelActions(agentActivities, agentDirectory, projectId, panel.agentId);
-          const minimized = Boolean(minimizedPanels[panel.key]);
-          const status = codingAgentPanelStatus(agentPanelRegistry, panel);
-          const indicator = status === "working" ? " is-connected" : status === "disconnected" ? " is-error" : "";
-          return <article key={panel.key} data-panel-key={panel.key} data-agent-id={panel.agentId} data-project-id={panel.projectId} className={`coding-agent-monitor${minimized ? " is-minimized" : ""}`}>
-            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${status === "working" ? " is-active" : ""}`} aria-hidden="true" /><strong>{profile?.agent_name ?? profile?.name ?? panel.agentId}</strong><span className={`workspace-monitor-indicator${indicator}`}>{status}</span><button type="button" aria-label={`${minimized ? "Expand" : "Minimize"} agent panel ${panel.agentId}`} onClick={() => setMinimizedPanels((current) => ({ ...current, [panel.key]: !current[panel.key] }))}>{minimized ? "□" : "−"}</button><button type="button" aria-label={`Close agent panel ${panel.agentId} in project ${panel.projectId}`} onClick={() => onAgentPanelClose?.(panel.projectId, panel.agentId)}>×</button></header>
-            {!minimized && <div className="workspace-monitor-content" aria-live="polite">
-              {actions.length === 0 && <p>Waiting for agent activity.</p>}
-              {actions.slice().reverse().map((activity, index) => <article key={activity.event_id ?? index}><small>{[String(activity.payload.activity_type ?? "activity").replaceAll("_", " "), activity.payload.status, activity.timestamp ? new Date(activity.timestamp).toLocaleTimeString() : null].filter(Boolean).join(" · ")}</small><span>{activity.payload.summary}{activity.payload.tool_name ? ` (${activity.payload.tool_name})` : ""}</span></article>)}
-            </div>}
-          </article>;
-        })}
-        {panels.length === 0 && <p className="coding-workspace-empty">No agent panels are open.</p>}
+        <div className="coding-workspace-row" aria-label="Workspace Agent upper row" />
+        <div className="coding-workspace-row" aria-label="Workspace Agent monitors row">
+          <section className="coding-workspace-monitor-column coding-agent-monitor" aria-label="Agents Activity monitor">
+            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${agentActive ? " is-active" : watcherState !== "connected" ? " is-offline" : ""}`} aria-label={agentActive ? "Agent working" : "Agent idle"} role="img" /><h3>Agents Activity</h3><span className={`workspace-monitor-indicator ${indicatorClass}`}>{watcherStatus}</span></header>
+            <div className="workspace-monitor-content" aria-live="polite">
+              {visibleActivities.length === 0 ? <p className="coding-workspace-empty">Waiting for agent activity.</p> : visibleActivities.slice().reverse().map((item) => <article key={item.key} data-agent-id={item.agentId}><small><strong style={{ color: item.tone }}>{item.agentName}</strong> · {item.activityType} · {item.status}{item.time ? ` · ${item.time}` : ""}</small><span>{item.detail}</span></article>)}
+            </div>
+          </section>
+          <section className="coding-workspace-monitor-column coding-agent-monitor" aria-label="Watcher monitor">
+            <header className="workspace-monitor-header"><span className={`workspace-monitor-light${watcherActive ? " is-active" : watcherState !== "connected" ? " is-offline" : ""}`} aria-label={watcherActive ? "Watcher working" : "Watcher idle"} role="img" /><h3>Watcher</h3><span className={`workspace-monitor-indicator ${indicatorClass}`}>{watcherStatus}</span></header>
+            <div className="workspace-monitor-content" aria-live="polite">
+              {watcherItems.length === 0 ? <p className="coding-workspace-empty">Waiting for watcher events.</p> : watcherItems.map((item) => <article key={item.key}><small>{item.meta}</small><span>{item.text}</span></article>)}
+            </div>
+          </section>
+        </div>
       </div>
     </section>
-    <div className="workspace-monitor-dock" role="group" aria-label="Coding agent monitors">
-      {workingAgents.map(({ agentId }) => {
-        const profile = codingAgentProfile(agentDirectory, agentId, projectId);
-        const key = codingAgentPanelKey(projectId, agentId);
-        return <button key={key} type="button" aria-pressed={openKeys.has(key)} onClick={() => onAgentPanelOpen?.(projectId, agentId)}><span className="workspace-monitor-light is-active" aria-hidden="true" />{profile?.agent_name ?? profile?.name ?? agentId}</button>;
-      })}
-    </div>
   </main>;
 }
-
-// Recover the validated project/agent identity encoded in a registry panel key.
-function codingPanelIdentity(key) {
-  try {
-    const parsed = JSON.parse(key);
-    return Array.isArray(parsed) ? { projectId: parsed[0], agentId: parsed[1] } : null;
-    // eslint-disable-next-line no-silent-catch -- unparseable keys are registry internals, never dock candidates
-  } catch (error) {
-    return null;
-  }
-}
```

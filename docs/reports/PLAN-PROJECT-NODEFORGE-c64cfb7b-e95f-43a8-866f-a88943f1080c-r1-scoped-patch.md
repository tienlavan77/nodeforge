<!--
Business purpose: Materializes the exact scoped unified Git patch against base commit 131a628f042a27f0098df3dfb62f03a1a50223b4 for PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1, Round 4) outside .forge/ so the independent Reviewer (RV) can inspect the verbatim scoped diff even when unfiltered git_diff exceeds size limits due to unrelated working-tree files.
Technical description: Contains the exact unified diff hunks for the core Coding workspace implementation and supervisor browser layout files, paired with the immutable Git revision and SHA-256 manifest in PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-verification.md.
-->
# Scoped Unified Patch — PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c (r1, Round 4)

- **Base Commit SHA**: `131a628f042a27f0098df3dfb62f03a1a50223b4` (parent: `a53aeef27ba6a09c1d3634aa925e7e32fe5b9554`)
- **Verification Manifest**: `docs/reports/PLAN-PROJECT-NODEFORGE-c64cfb7b-e95f-43a8-866f-a88943f1080c-r1-verification.md`

```diff
diff --git a/ui/nextjs/app/coding/page.jsx b/ui/nextjs/app/coding/page.jsx
--- a/ui/nextjs/app/coding/page.jsx
+++ b/ui/nextjs/app/coding/page.jsx
@@ -43,6 +43,9 @@ export default function CodingPage() {
   const [agentDirectory, setAgentDirectory] = useState([]);
   const [agentActivities, setAgentActivities] = useState([]);
+  const [watcherEvents, setWatcherEvents] = useState([]);
+  const [watcherPulseId, setWatcherPulseId] = useState(0);
+  const [watcherState, setWatcherState] = useState("connecting");
   const [agentPanelRegistry, setAgentPanelRegistry] = useState(() => createCodingAgentPanelRegistry());
   const panelPersister = useRef(null);
@@ -54,10 +57,15 @@ export default function CodingPage() {
     return () => { panelPersister.current?.flush(); panelPersister.current = null; };
   }, [PROJECT_ID]);
 
   const setPanelSource = useCallback((source) => {
+    setWatcherState(source);
     setAgentPanelRegistry((current) => setCodingAgentPanelSource(current, source));
   }, []);
+
+  useEffect(() => {
+    setAgentActivities([]);
+    setWatcherEvents([]);
+    setWatcherPulseId(0);
+    setWatcherState("connecting");
+  }, [PROJECT_ID]);
 
   const refreshAgents = useCallback(async () => {
@@ -101,8 +109,8 @@ export default function CodingPage() {
   useProjectEventStream({
     client,
     projectId: PROJECT_ID,
     refreshAgents,
     refreshGit,
-    setWatcherEvents: () => {},
-    setWatcherPulseId: () => {},
+    setWatcherEvents,
+    setWatcherPulseId,
     setWatcherState: setPanelSource,
     setAgentActivities,
@@ -119,6 +127,9 @@ export default function CodingPage() {
       gitStatus={gitStatus}
       agentDirectory={agentDirectory}
       agentActivities={agentActivities}
+      watcherEvents={watcherEvents}
+      watcherPulseId={watcherPulseId}
+      watcherState={watcherState}
       agentPanelRegistry={agentPanelRegistry}
       onMinimizeAgentPanel={minimizeAgentPanel}
       onCloseAgentPanel={closeAgentPanel}
diff --git a/ui/nextjs/components/coding-workspace-monitor.jsx b/ui/nextjs/components/coding-workspace-monitor.jsx
--- a/ui/nextjs/components/coding-workspace-monitor.jsx
+++ b/ui/nextjs/components/coding-workspace-monitor.jsx
@@ -6,16 +6,26 @@ import { WorkspaceNavigationHeader } from "./workspace-navigation-header.jsx";
 import { CodingArchitecturePlans } from "./coding-architecture-plans.jsx";
 import { SprintPlanDashboard } from "./sprint-plan-dashboard.jsx";
+import { displayMessageTime } from "../lib/home-page-watcher-events.js";
+import { resolveCodingAgentActivities, resolveCodingAgentTone } from "../lib/coding-workspace-activity.js";
+
+export { resolveCodingAgentActivities, resolveCodingAgentTone };
 
 export function CodingWorkspaceMonitor({
   projectId = null,
   gitStatus = null,
   agentDirectory = [],
   agentActivities = [],
+  watcherEvents = [],
+  watcherPulseId = 0,
+  watcherState = "connecting",
   dashboard = null,
   plans = [],
   planRequests = [],
   checkpoints = [],
   onRefreshCoding = null,
   onSprintDeleted = null,
   onTicketDeleted = null
 }) {
+  const activities = resolveCodingAgentActivities(agentActivities, agentDirectory, projectId);
+  const files = Array.isArray(watcherEvents) ? watcherEvents : [];
+  const connectionTone = watcherState === "connected" ? "#059669" : watcherState === "disconnected" ? "#dc2626" : "#d97706";
+  const connectionTitle = watcherState === "connected" ? "Watcher connected" : watcherState === "disconnected" ? "Watcher disconnected" : "Watcher reconnecting";
@@ -32,33 +42,41 @@ export function CodingWorkspaceMonitor({
         <section className="coding-workspace-column coding-workspace-agent" aria-label="Workspace Agent">
           <div className="coding-workspace-column-header">
             <span className="workspace-panel-title">Workspace Agent</span>
           </div>
           <div className="coding-workspace-list">
-            {/* Replaced individual agent panels with 2-row equal grid: empty upper row + 2-column lower row */}
+            <div className="coding-workspace-row coding-workspace-row-upper" aria-label="Workspace Agent upper row" />
+            <div className="coding-workspace-row coding-workspace-row-lower" aria-label="Workspace Agent monitors row">
+              <article className="workspace-monitor-panel coding-agent-monitor coding-workspace-monitor-column coding-agents-activity-monitor" aria-label="Agents Activity">
+                <div className="workspace-monitor-panel-header coding-agent-monitor-header">
+                  <span className="workspace-panel-title">Agents Activity</span>
+                  <span className="coding-agent-role">{activities.length}</span>
+                </div>
+                <div className="workspace-monitor-panel-content">
+                  {activities.length === 0 ? <p className="workspace-monitor-empty">Waiting for agent activity...</p> : (
+                    <ul className="workspace-monitor-list">
+                      {activities.map((item) => (
+                        <li key={item.key} className="workspace-monitor-item">
+                          <span className="workspace-monitor-agent" style={{ color: item.tone }}>{item.agentName}</span>
+                          <span className="workspace-monitor-type">{item.activityType}</span>
+                          <span className="workspace-monitor-status">{item.status}</span>
+                          {item.time ? <span className="workspace-monitor-time">{item.time}</span> : null}
+                          <span className="workspace-monitor-summary">{item.detail}</span>
+                        </li>
+                      ))}
+                    </ul>
+                  )}
+                </div>
+              </article>
+              <article className="workspace-monitor-panel coding-agent-monitor coding-workspace-monitor-column coding-watcher-monitor" aria-label="Watcher">
+                <div className="workspace-monitor-panel-header coding-agent-monitor-header">
+                  <span className="workspace-panel-title">Watcher</span>
+                  <span className="workspace-watcher-indicators">
+                    <span className="workspace-watcher-status-dot" title={connectionTitle} style={{ background: connectionTone }} />
+                    {watcherPulseId > 0 ? <span key={watcherPulseId} className="workspace-watcher-pulse-dot" title="Watcher file activity received" /> : null}
+                  </span>
+                </div>
+                <div className="workspace-monitor-panel-content">
+                  {files.length === 0 ? <p className="workspace-monitor-empty">Waiting for file events...</p> : (
+                    <ul className="workspace-monitor-list">
+                      {files.map((event, index) => (
+                        <li key={event.id ?? `${event.file}-${index}`} className="workspace-monitor-item">
+                          <span className="workspace-monitor-status">{event.type === "removed" ? "Removed" : "Indexed"}</span>
+                          {displayMessageTime(event.timestamp) ? <span className="workspace-monitor-time">{displayMessageTime(event.timestamp)}</span> : null}
+                          <span className="workspace-monitor-summary">{event.file}</span>
+                        </li>
+                      ))}
+                    </ul>
+                  )}
+                </div>
+              </article>
+            </div>
           </div>
         </section>
       </div>
-      {/* Removed .workspace-monitor-dock */}
     </main>
   );
 }
diff --git a/ui/nextjs/lib/coding-workspace-activity.js b/ui/nextjs/lib/coding-workspace-activity.js
new file mode 100644
--- /dev/null
+++ b/ui/nextjs/lib/coding-workspace-activity.js
@@ -0,0 +1,63 @@
+import { codingAgentPanelKey, codingAgentProfile } from "./coding-agent-panel-registry.js";
+import { agentDisplayName, displayMessageTime } from "./home-page-watcher-events.js";
+
+const AGENT_TONES = ["#82aaff", "#7ee787", "#ffcb6b", "#c792ea", "#89ddff", "#f78c6c", "#f07178", "#c3e88d"];
+
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
+export function resolveCodingAgentTone(agentId, explicitColor) {
+  if (isAccessibleMonitorColor(explicitColor)) return explicitColor.trim();
+  const key = String(agentId ?? "agent").trim() || "agent";
+  let hash = 0;
+  for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) >>> 0;
+  return AGENT_TONES[hash % AGENT_TONES.length];
+}
+
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
--- a/ui/nextjs/app/styles/workspace-monitors.css
+++ b/ui/nextjs/app/styles/workspace-monitors.css
@@ -16,13 +16,15 @@
-.coding-workspace-agent .coding-workspace-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); align-content: start; }
+.coding-workspace-agent { display: flex; flex-direction: column; }
+.coding-workspace-agent .coding-workspace-list { display: grid; flex: 1; min-height: 0; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; padding: 10px 12px; overflow: hidden; }
+.coding-workspace-row { min-height: 0; overflow: hidden; }
+.coding-workspace-row-upper { border: 1px dashed rgba(255, 255, 255, 0.06); border-radius: 6px; background: rgba(255, 255, 255, 0.01); }
+.coding-workspace-row-lower { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; min-height: 0; }
+.coding-workspace-monitor-column { min-height: 0; height: 100%; overflow: hidden; }
```

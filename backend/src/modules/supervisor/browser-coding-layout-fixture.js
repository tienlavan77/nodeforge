// Renders committed Coding columns with overflowing real agent panels to verify pinned headers and responsive tracks.
import React from "react";
import { createRoot } from "react-dom/client";
import { CodingWorkspaceMonitor } from "@ticket/ui/components/coding-workspace-monitor.jsx";
import "@ticket/ui/app/styles/responsive-workspace.css";
import "@ticket/ui/app/styles/workspace-monitors.css";

const projectId = "PROJECT-NODEFORGE";
const panels = Array.from({ length: 7 }, (_, index) => ({ key: `panel-${index}`, agentId: `coder-${index}`, projectId }));
const agents = panels.map((panel) => ({ agent_id: panel.agentId, project_id: projectId, role: "coder", name: panel.agentId, status: "idle" }));
const activities = panels.flatMap((panel) => Array.from({ length: 30 }, (_, index) => ({ event_type: "agent.activity", project_id: projectId, payload: { agent_id: panel.agentId, summary: `Activity ${index} ${"Long workspace activity content ".repeat(8)}`, tool_name: "read_file" } })));
window.layoutFixture = { gitProjects: [], closedPanels: [] };
const client = { getGitStatus: async (id) => { window.layoutFixture.gitProjects.push(id); return null; }, listPlans: async () => [], listPlanRequests: async () => [] };
const style = document.createElement("style");
style.textContent = ":root{--app-panel:#fff;--app-border:#ccc;--app-text:#222;--app-surface-alt:#eee}body{margin:0}.claude-home-shell{display:grid;height:100vh}.conversation-sidebar{min-width:0}";
document.head.append(style);
createRoot(document.getElementById("root")).render(React.createElement("div", { className: "claude-home-shell coding-workspace-shell" },
  React.createElement("aside", { className: "conversation-sidebar is-collapsed" }),
  React.createElement(CodingWorkspaceMonitor, { projectId, client, agentPanelRegistry: { panels, activity: {}, sourceStatus: "connected" }, agentDirectory: agents, agentActivities: activities,
    onAgentPanelClose: (scope, agentId) => window.layoutFixture.closedPanels.push({ projectId: scope, agentId }) })));

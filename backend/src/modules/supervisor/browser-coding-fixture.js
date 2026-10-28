// Exercises the committed Coding components with controlled project events and no real API mutations.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { CodingWorkspaceMonitor } from "@ticket/ui/components/coding-workspace-monitor.jsx";
import { createCodingAgentPanelRegistry, updateCodingAgentPanelRegistry, setCodingAgentPanelSource, closeCodingAgentPanel } from "@ticket/ui/lib/coding-agent-panel-registry.js";
import "@ticket/ui/app/styles/workspace-monitors.css";
import "@ticket/ui/app/styles/sprint-ticket.css";
import "@ticket/ui/app/styles/ticket-dialogs.css";

const projectId = "PROJECT-BROWSER";
const profiles = [
  { agent_id: "leader", agent_name: "Leader", role: "sprint_leader", status: "ready" },
  { agent_id: "coder-1", agent_name: "Same name", role: "coder", status: "ready" },
  { agent_id: "coder-2", agent_name: "Same name", role: "coder", status: "not_connected" },
  { agent_id: "reviewer", agent_name: "Reviewer", role: "reviewer", status: "ready" }
];
const ticket = { id: "TICKET-BROWSER", project_id: projectId, sprint_id: "SPRINT-BROWSER", title: "Controlled ticket", status: "pending", progress: 0, acceptance_criteria: [] };
const sprint = { id: ticket.sprint_id, project_id: projectId, objective: "Preserve Sprint controls", status: "ready", version: 7, tasks: [ticket], tickets: [ticket], exit_criteria: [] };
const dashboard = { project_id: projectId, roadmap: { sprints: [sprint] } };
const calls = [];
let streamEvent;

// Records UI callback arguments without invoking production RUN, approval or deletion endpoints.
function record(name, args, result) {
  calls.push({ name, args });
  return Promise.resolve(result);
}

const client = {
  listPlans: async () => [], listPlanRequests: async () => [], listCodeCheckpoints: async () => ({ checkpoints: [] }),
  // Defines close method behavior for browser-coding-fixture.js.
  connectProjectStream: ({ onEvent }) => { streamEvent = onEvent; return { close() {} }; },
  getSprintPlan: (...args) => record("getSprintPlan", args, sprint),
  runSprintPlan: (...args) => record("runSprintPlan", args, { sprint_id: sprint.id, levels: [] }),
  deleteSprintPlan: (...args) => record("deleteSprintPlan", args, { archived: true }),
  getTicket: (...args) => record("getTicket", args, ticket),
  runTicket: (...args) => record("runTicket", args, { status: "accepted" }),
  deleteTicket: (...args) => record("deleteTicket", args, { sprint_id: sprint.id }),
  runCode: (...args) => record("runCode", args, { agent_id: "coder-1", response: "Recorded" })
};

// Keeps real React reconciliation active while delivering deterministic boundary events for each browser assertion.
function BrowserFixture() {
  const [snapshot, setSnapshot] = useState({ registry: setCodingAgentPanelSource(createCodingAgentPanelRegistry(), "connected"), directory: profiles, activities: [] });
  window.browserFixture.update = ({ events = [], directory = snapshot.directory, source } = {}) => {
    let registry = source ? setCodingAgentPanelSource(snapshot.registry, source) : snapshot.registry;
    registry = updateCodingAgentPanelRegistry(registry, projectId, events, directory);
    flushSync(() => setSnapshot({ registry, directory, activities: events }));
  };
  return React.createElement(CodingWorkspaceMonitor, { projectId, dashboard, client, agentDirectory: snapshot.directory, agentActivities: snapshot.activities, agentPanelRegistry: snapshot.registry,
    // Exercise the real accessible panel control using the same exact-identity registry boundary as Coding.
    onAgentPanelClose: (scope, agentId) => setSnapshot((current) => ({ ...current, registry: closeCodingAgentPanel(current.registry, scope, agentId) })),
    onRefresh: () => { calls.push({ name: "refresh", args: [] }); }, onTicketDeleted: (...args) => { calls.push({ name: "ticketDeleted", args }); }, onSprintDeleted: (...args) => { calls.push({ name: "sprintDeleted", args }); } });
}

const root = createRoot(document.getElementById("root"));
let revision = 0;
window.browserFixture = { profiles, calls, projectId,
  reset: () => { calls.length = 0; flushSync(() => root.render(React.createElement(BrowserFixture, { key: ++revision }))); },
  emit: (event) => streamEvent?.(event)
};
window.browserFixture.reset();

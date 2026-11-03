// Prevents the sidebar-free Coding page from being squeezed into Home's 350px conversation track and verifies the 2-row Workspace Agent monitor layout.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveCodingAgentActivities, resolveCodingAgentTone } from "../lib/coding-workspace-activity.js";

const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/workspace-monitors.css", import.meta.url), "utf8");
const globals = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");

// Read individual CSS declarations so layout assertions do not depend on declaration order.
function declarations(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = styles.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, "m"))?.[1];
  assert.ok(body, `Missing rule: ${selector}`);
  return Object.fromEntries(body.split(";").filter((entry) => entry.includes(":")).map((entry) => {
    const separator = entry.indexOf(":");
    return [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()];
  }));
}

test("Coding places a shared page header with project and Git status above both independently scrolling columns", () => {
  const column = declarations(".coding-workspace-column");
  assert.equal(column["min-height"], "0");
  assert.equal(column["overflow-y"], "auto");
  assert.equal(column["overflow-x"], "hidden");
  const pageHeader = declarations(".coding-workspace-header");
  assert.equal(pageHeader["grid-column"], "1 / -1");
  assert.equal(pageHeader.background, "var(--app-panel)");
  const header = declarations(".coding-workspace-column-header");
  assert.equal(header.position, "sticky");
  assert.equal(header.top, "0");
  assert.equal(header.background, "var(--app-panel)");
  assert.equal(header["flex-wrap"], "wrap");
  for (const heading of ["coding-sprint-plan-heading", "coding-workspace-agent-heading"]) {
    assert.match(monitor, new RegExp(`<header\\b(?=[^>]*className="coding-workspace-column-header")[^>]*>\\s*<h1\\b(?=[^>]*id="${heading}")[^>]*>`));
  }
  assert.match(monitor, /<header\b(?=[^>]*className="[^"]*\bclaude-chat-header\b[^"]*\bcoding-workspace-header\b[^"]*")[^>]*>\s*<h1>(Coding|Code)<\/h1>\s*<ConversationHeaderProjectGit\b[^>]*\/>\s*<\/header>/);
  const git = monitor.match(/<ConversationHeaderProjectGit\b[^>]*\/>/)?.[0];
  assert.ok(git);
  assert.match(git, /\bclient\s*=\s*\{client\}/);
  assert.match(git, /\bprojectId\s*=\s*\{projectId\}/);
  assert.doesNotMatch(monitor, /coding-workspace-git-status|<GitStatusIndicator\b/);
  assert.ok(monitor.indexOf("coding-workspace-header") < monitor.indexOf("coding-sprint-plan"));
  const wiring = page.match(/<CodingWorkspaceMonitor\b[^>]*\/>/)?.[0];
  assert.match(wiring, /\bprojectId\s*=\s*\{PROJECT_ID\}/);
  assert.match(wiring, /\bclient\s*=\s*\{client\}/);
  assert.match(wiring, /\bwatcherState\s*=\s*\{watcherState\}/);
});

test("Coding Workspace Agent uses a 2-row equal grid without conflicting percentage height and two equal lower monitor columns", () => {
  const agentCol = declarations(".coding-workspace-agent");
  assert.equal(agentCol.display, "flex");
  assert.equal(agentCol["flex-direction"], "column");
  assert.equal(agentCol["container-type"], "inline-size");
  const list = declarations(".coding-workspace-list");
  assert.equal(list.display, "grid");
  assert.equal(list.flex, "1");
  assert.equal(list["min-height"], "0");
  assert.equal(list["grid-template-columns"], "minmax(0, 1fr)");
  assert.equal(list["grid-template-rows"], "minmax(0, 1fr) minmax(0, 1fr)");
  const row = declarations(".coding-workspace-row");
  assert.equal(row.display, "grid");
  assert.equal(row["grid-template-columns"], "repeat(2, minmax(0, 1fr))");
  assert.equal(row["min-height"], "0");
  assert.equal(row.height, undefined);
  const monitorCol = declarations(".coding-workspace-monitor-column");
  assert.equal(monitorCol.display, "flex");
  assert.equal(monitorCol["flex-direction"], "column");
  assert.equal(monitorCol["min-width"], "0");
  assert.equal(monitorCol["min-height"], "0");
  assert.equal(monitorCol.overflow, "hidden");
  assert.doesNotMatch(monitor, /workspace-monitor-dock/);
});

test("Only Coding monitor chrome loses padding while monitor content scrolls inside bounded columns", () => {
  assert.equal(declarations(".workspace-monitor-header").padding, "0 10px 0 14px");
  assert.equal(declarations(".workspace-monitor-header").flex, "none");
  assert.equal(declarations(".coding-agent-monitor .workspace-monitor-header").padding, "0");
  assert.equal(declarations(".coding-agent-monitor .workspace-monitor-content").padding, "0");
  assert.equal(declarations(".coding-agent-monitor strong").display, "inline");
  const content = declarations(".workspace-monitor-content");
  assert.equal(content.padding, "10px 14px");
  assert.equal(content["min-height"], "0");
  assert.equal(content.overflow, "auto");
  const panel = declarations(".coding-agent-monitor");
  assert.equal(panel.display, "flex");
  assert.equal(panel["flex-direction"], "column");
  assert.equal(panel["box-sizing"], "border-box");
  assert.equal(panel.overflow, "hidden");
});

test("Coding restores navigation before the workspace without conversation controls and resets realtime monitor state on project switch", () => {
  assert.match(page, /className="claude-home-shell coding-workspace-shell"/);
  assert.ok(page.indexOf("<ConversationSidebar") < page.indexOf("<CodingWorkspaceMonitor"));
  assert.match(page, /showConversationControls=\{false\}/);
  assert.match(page, /open=\{openSidebar\} onOpen=\{\(\) => setOpenSidebar\(true\)\} onClose=\{\(\) => setOpenSidebar\(false\)\}/);
  assert.match(page, /setAgentActivities\(\[\]\)/);
  assert.match(page, /setWatcherEvents\(\[\]\)/);
  assert.match(page, /setWatcherPulseId\(null\)/);
  assert.match(page, /setWatcherState\("connecting"\)/);
  assert.match(styles, /\.claude-home-shell\.coding-workspace-shell[^{]*\{[^}]*grid-template-columns:\s*350px minmax\(0, 1fr\);[^}]*grid-template-rows:\s*minmax\(0, 1fr\)/);
  assert.ok(globals.indexOf("styles/workspace-monitors.css") > globals.indexOf("styles/home-workspace.css"));
});

test("Coding fills the viewport and keeps scrollable columns without changing Home or the internal split", () => {
  assert.match(styles, /\.coding-workspace-shell > \.coding-workspace-monitor\s*\{[^}]*width:\s*100%;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*height:\s*100%;[^}]*overflow:\s*auto/);
  assert.match(styles, /\.coding-workspace-shell \.coding-workspace-column\s*\{[^}]*min-height:\s*0;[^}]*box-sizing:\s*border-box/);
  assert.match(styles, /grid-template-columns:\s*minmax\(0, 1fr\) minmax\(260px, 2fr\)/);
  assert.match(styles, /grid-template-rows:\s*auto minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 760px\)[^\n]*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(styles, /\.claude-home-shell\s*\{/);
  assert.match(styles, /coding-workspace-shell:has\(\.conversation-sidebar.is-collapsed\)[^{]*\{[^}]*grid-template-columns:\s*42px minmax\(0, 1fr\)/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?padding-left:\s*56px/);
  assert.match(styles, /coding-workspace-shell \.conversation-mobile-rail[^{]*\{[^}]*display:\s*flex;[^}]*top:\s*0/);
  assert.match(styles, /@media \(min-width: 641px\)[\s\S]*?responsive-region--conversations[^{]*\{[^}]*position:\s*static/);
});

test("Unified Agents Activity resolver formats multiple agents, missing optional fields, deterministic tones, and project isolation", () => {
  const directory = [
    { agent_id: "coder-1", agent_name: "Alpha Coder", role: "coder", project_id: "PROJ-A" },
    { agent_id: "reviewer-1", name: "Beta Reviewer", role: "reviewer", project_id: "PROJ-A" },
    { agent_id: "leader-1", label: "Sprint Lead", role: "sprint_leader", project_id: "PROJ-A" }
  ];
  const activities = [
    { event_id: "ev-1", event_type: "agent.activity", project_id: "PROJ-A", timestamp: "2026-11-02T10:00:00.000Z", payload: { agent_id: "coder-1", activity_type: "tool_started", status: "working", summary: "Inspecting layout", tool_name: "read_file" } },
    { event_id: "ev-2", event_type: "agent.activity", project_id: "PROJ-A", payload: { agent_id: "reviewer-1", tool_name: "search_text" } },
    { event_id: "ev-foreign", event_type: "agent.activity", project_id: "PROJ-B", payload: { agent_id: "coder-1", summary: "Foreign project" } }
  ];
  const resolved = resolveCodingAgentActivities(activities, directory, "PROJ-A");
  assert.equal(resolved.length, 2);
  assert.equal(resolved[0].agentName, "Alpha Coder");
  assert.equal(resolved[0].activityType, "tool started");
  assert.equal(resolved[0].status, "working");
  assert.equal(resolved[0].detail, "Inspecting layout (read_file)");
  assert.ok(resolved[0].time.length > 0);
  assert.equal(resolved[1].agentName, "Beta Reviewer");
  assert.equal(resolved[1].activityType, "activity");
  assert.equal(resolved[1].status, "working");
  assert.equal(resolved[1].detail, "search_text");
  assert.equal(resolved[0].tone, resolveCodingAgentTone("coder-1"));
  assert.equal(resolveCodingAgentTone("coder-1"), resolveCodingAgentTone("coder-1"));
  assert.equal(resolveCodingAgentTone("coder-1", "#7ee787"), "#7ee787");
  assert.equal(resolveCodingAgentTone("coder-1", "transparent"), resolveCodingAgentTone("coder-1"));
  assert.equal(resolveCodingAgentTone("coder-1", "#123456"), resolveCodingAgentTone("coder-1"));
  assert.equal(resolveCodingAgentTone("coder-1", "rgba(0, 0, 0, 0)"), resolveCodingAgentTone("coder-1"));
  const conflicting = resolveCodingAgentActivities([
    { event_id: "C-1", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "transparent", payload: { agent_id: "coder-1", summary: "First step", agent_color: "#000000" } },
    { event_id: "C-2", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#ffcb6b", payload: { agent_id: "coder-1", summary: "Second step", agent_color: "#89ddff" } },
    { event_id: "C-3", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#f07178", payload: { agent_id: "coder-1", summary: "Third step" } }
  ], directory, "PROJ-A");
  assert.equal(conflicting.length, 3);
  assert.equal(conflicting[0].tone, resolveCodingAgentTone("coder-1"));
  assert.equal(conflicting[1].tone, conflicting[0].tone);
  assert.equal(conflicting[2].tone, conflicting[0].tone);

  const rollingBuffer = [
    { event_id: "R-1", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#ffcb6b", payload: { agent_id: "coder-1", summary: "Oldest event", agent_color: "#ffcb6b" } },
    { event_id: "R-2", event_type: "agent.activity", project_id: "PROJ-A", agent_color: "#89ddff", payload: { agent_id: "coder-1", summary: "Newer event", agent_color: "#89ddff" } }
  ];
  const beforeEviction = resolveCodingAgentActivities(rollingBuffer, directory, "PROJ-A");
  const afterEviction = resolveCodingAgentActivities(rollingBuffer.slice(1), directory, "PROJ-A");
  assert.equal(beforeEviction.length, 2);
  assert.equal(afterEviction.length, 1);
  assert.equal(beforeEviction[0].tone, resolveCodingAgentTone("coder-1"));
  assert.equal(beforeEviction[1].tone, beforeEviction[0].tone);
  assert.equal(afterEviction[0].tone, beforeEviction[1].tone);

  const profiledDirectory = [{ agent_id: "coder-1", project_id: "PROJ-A", role: "coder", agent_name: "Coder One", color: "#ffcb6b" }];
  assert.equal(resolveCodingAgentActivities(rollingBuffer, profiledDirectory, "PROJ-A")[0].tone, "#ffcb6b");
  assert.equal(resolveCodingAgentActivities(rollingBuffer.slice(1), profiledDirectory, "PROJ-A")[0].tone, "#ffcb6b");

  const seDirectory = [...directory, { agent_id: "se-1", agent_name: "System Engineer", role: "system_engineer", project_id: "PROJ-A" }];
  const seActivities = resolveCodingAgentActivities([
    { event_id: "se-tool", event_type: "agent.activity", project_id: "PROJ-A", payload: { agent_id: "se-1", activity_type: "tool_completed", status: "success", summary: "Forge tool edit_diff success", tool_name: "edit_diff" } },
    { event_id: "se-turn", event_type: "agent.activity", project_id: "PROJ-A", payload: { agent_id: "se-1", agent_role: "system_engineer", activity_type: "progress", status: "working", summary: "System Engineer reply", sdk_event: { type: "conversation_turn", entries: [] } } }
  ], seDirectory, "PROJ-A");
  assert.equal(seActivities.length, 1);
  assert.equal(seActivities[0].agentName, "System Engineer");
  assert.equal(seActivities[0].role, "system_engineer");
  assert.equal(seActivities[0].activityType, "tool completed");
  assert.equal(seActivities[0].status, "success");

  assert.match(monitor, /latestWatcherKey/);
  assert.match(monitor, /latestActivityKey/);
  assert.match(monitor, /hasWorkingAgent/);
});

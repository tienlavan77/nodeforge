// Verify Coding panel identity, isolated actions, and live lifecycle without persistence or backend changes.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  codingAgentPanelKey, codingAgentProfile, createCodingAgentPanelRegistry,
  updateCodingAgentPanelRegistry, codingAgentPanelActions, codingAgentPanelStatus,
  setCodingAgentPanelSource, closeCodingAgentPanel
} from "../lib/coding-agent-panel-registry.js";

const projectId = "PROJECT-1";
const agents = [
  { agent_id: "leader", agent_name: "Sprint Leader", role: "sprint_leader", status: "ready" },
  { agent_id: "coder-1", agent_name: "Same name", role: "coder", status: "ready" },
  { agent_id: "coder-2", agent_name: "Same name", role: "coder", status: "disabled" },
  { agent_id: "reviewer", agent_name: "Reviewer", role: "reviewer", status: "ready" }
];

// Build controlled existing-contract actions with distinguishable agent content.
function action(agentId, status = "working", scope = projectId, step = 1) {
  return { project_id: scope, event_type: "agent.activity", event_id: `event-${agentId}-${step}`,
    timestamp: `2026-10-13T00:00:0${step}.000Z`, payload: { agent_id: agentId, status,
      summary: `${agentId} action ${step}`, activity_type: "tool_started", tool_name: "read_file" } };
}

// Apply an event batch through the same boundary used at Coding stream delivery.
function deliver(registry, events, directory = agents, scope = projectId) {
  return updateCodingAgentPanelRegistry(registry, scope, events, directory);
}

test("AC-1/3/4/13/14/15: four exact identities, correct profiles, and isolated actions", () => {
  const events = agents.map((agent) => action(agent.agent_id));
  const registry = deliver(createCodingAgentPanelRegistry(), events);
  assert.equal(registry.panels.length, 4);
  assert.equal(new Set(registry.panels.map((panel) => panel.key)).size, 4);
  for (const [index, panel] of registry.panels.entries()) {
    assert.equal(panel.key, codingAgentPanelKey(projectId, agents[index].agent_id));
    const profile = codingAgentProfile(agents, panel.agentId, projectId);
    assert.equal(profile.agent_name, agents[index].agent_name);
    assert.equal(profile.role, agents[index].role);
    const selected = codingAgentPanelActions([...events, action(panel.agentId, "working", "FOREIGN")], agents, projectId, panel.agentId);
    assert.deepEqual(selected, [events[index]]);
  }
  const otherProject = deliver(registry, [action("coder-1", "working", "PROJECT-2")], agents, "PROJECT-2");
  assert.equal(otherProject.panels.length, 5);
  assert.notEqual(otherProject.panels[4].key, registry.panels[1].key);
});

test("AC-2/3/7/17: repeated, reconnect, and multi-step deliveries retain rendering identities", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-1")]);
  const panel = registry.panels[0];
  registry = setCodingAgentPanelSource(registry, "connected");
  registry = deliver(registry, [action("coder-1"), action("coder-1", "working", projectId, 2)]);
  const renamed = agents.map((agent) => ({ ...agent, agent_name: "Changed", role: "reviewer" }));
  registry = deliver(registry, [{ ...action("coder-1"), event_id: "reconnect", timestamp: "changed" }], renamed);
  assert.equal(registry.panels.length, 1);
  assert.strictEqual(registry.panels[0], panel);
  assert.equal(registry.panels[0].key, codingAgentPanelKey(projectId, "coder-1"));
});

test("AC-2/6/16: delayed directory evidence opens once even after activity eviction", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-1")], []);
  assert.equal(registry.panels.length, 0);
  assert.deepEqual(codingAgentPanelActions([action("coder-1")], [], projectId, "coder-1"), []);
  registry = deliver(registry, [action("coder-1", "idle")], []);
  registry = deliver(registry, [], agents);
  assert.equal(registry.panels.length, 1);
  registry = deliver(registry, [], agents);
  assert.equal(registry.panels.length, 1);
  const insufficient = [{ agent_id: "coder-1", agent_name: "Coder" }];
  assert.equal(deliver(createCodingAgentPanelRegistry(), [action("coder-1")], insufficient).panels.length, 0);
});

test("AC-2/8/18: running-idle-running, success, failure, and buffer eviction preserve panels", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-1")]);
  const panel = registry.panels[0];
  for (const status of ["idle", "working", "success", "failure"]) {
    registry = deliver(registry, [action("coder-1", status)]);
    assert.strictEqual(registry.panels[0], panel);
  }
  let buffer = [action("coder-1")];
  for (let step = 0; step < 60; step += 1) {
    const event = action("reviewer", "working", projectId, step);
    registry = deliver(registry, [event]);
    buffer = [...buffer, event].slice(-50);
  }
  assert.equal(buffer.length, 50);
  assert.equal(codingAgentPanelActions(buffer, agents, projectId, "coder-1").length, 0);
  assert.strictEqual(registry.panels[0], panel);
  assert.equal(registry.panels.length, 2);
  assert.equal(deliver(createCodingAgentPanelRegistry(), [action("coder-1", "idle")]).panels.length, 0);
});

test("AC-5: invalid, foreign, conflicting, or ambiguous identity never routes work", () => {
  const invalid = [
    action(undefined), action(null), action({ id: "coder-1" }), action(" coder-1"), action(""),
    action("coder-1", "working", "FOREIGN"),
    { ...action("coder-1"), project_id: undefined },
    { ...action("coder-1"), agent_id: "coder-2" },
    { ...action("coder-1"), payload: { ...action("coder-1").payload, agentId: "coder-2" } },
    { ...action("coder-1"), payload: { ...action("coder-1").payload, project_id: "FOREIGN" } }
  ];
  for (const event of invalid) {
    assert.equal(deliver(createCodingAgentPanelRegistry(), [event]).panels.length, 0);
    assert.deepEqual(codingAgentPanelActions([event], agents, projectId, "coder-1"), []);
  }
  for (const directory of [
    [...agents, { ...agents[1] }],
    [{ ...agents[1], id: "coder-2" }],
    [{ ...agents[1], project_id: "FOREIGN" }]
  ]) {
    assert.equal(deliver(createCodingAgentPanelRegistry(), [action("coder-1")], directory).panels.length, 0);
    assert.deepEqual(codingAgentPanelActions([action("coder-1")], directory, projectId, "coder-1"), []);
  }
  assert.equal(deliver(createCodingAgentPanelRegistry(), [action("coder-1")], agents, null).panels.length, 0);
  assert.equal(codingAgentPanelKey(undefined, "coder-1"), null);
});

test("AC-9: profile status is not execution evidence; reconnect requires fresh activity", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-2")]);
  const panel = registry.panels[0];
  assert.equal(codingAgentPanelStatus(registry, panel), "unknown");
  registry = setCodingAgentPanelSource(registry, "connected");
  assert.equal(codingAgentPanelStatus(registry, panel), "unknown");
  registry = deliver(registry, [action("coder-2")]);
  assert.equal(codingAgentPanelStatus(registry, panel), "working");
  assert.equal(codingAgentProfile(agents, "coder-2", projectId).status, "disabled");
  registry = setCodingAgentPanelSource(registry, "error");
  assert.equal(codingAgentPanelStatus(registry, panel), "disconnected");
  registry = setCodingAgentPanelSource(registry, "connected");
  assert.equal(codingAgentPanelStatus(registry, panel), "unknown");
  assert.strictEqual(registry.panels[0], panel);
});

// Model a started boundary using the existing activity contract, with optional run correlation.
function started(agentId, step, correlation, status = "working") {
  const event = action(agentId, status, projectId, step);
  return { ...event, ...(correlation ? { correlation_id: correlation } : {}),
    payload: { ...event.payload, activity_type: "started" } };
}

test("close respects exact identity through same-run activity, replay and reconnect", () => {
  const boundary = started("coder-1", 1, "run-1");
  let registry = deliver(createCodingAgentPanelRegistry(), [boundary, action("coder-2")]);
  registry = deliver(registry, [action("coder-1", "working", "PROJECT-2")], agents, "PROJECT-2");
  const retained = [...registry.panels].filter((panel) => panel.projectId !== projectId || panel.agentId !== "coder-1");
  registry = closeCodingAgentPanel(registry, projectId, "coder-1");
  assert.deepEqual(registry.panels, retained);
  assert.strictEqual(closeCodingAgentPanel(registry, projectId, "missing"), registry);
  for (const status of ["working", "idle", "working"]) {
    registry = deliver(registry, [action("coder-1", status), boundary,
      { ...action("coder-1"), correlation_id: "run-1" }, started("coder-2", 2, "other-run"),
      { ...started("coder-1", 3, "foreign"), project_id: "FOREIGN" },
      { ...started("coder-1", 4, "conflict"), agent_id: "coder-2" }]);
    assert.deepEqual(registry.panels, retained);
  }
  const runs = registry.runs;
  for (const source of ["error", "connecting", "connected"]) {
    registry = setCodingAgentPanelSource(registry, source);
    assert.deepEqual(registry.activity, {});
    assert.strictEqual(registry.runs, runs);
    registry = deliver(registry, [boundary, action("coder-1")]);
    assert.deepEqual(registry.panels, retained);
  }
});

test("new correlation reopens only the matching working agent, not an idle boundary", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [started("coder-1", 1, "run-1"), action("coder-2")]);
  registry = closeCodingAgentPanel(closeCodingAgentPanel(registry, projectId, "coder-1"), projectId, "coder-2");
  registry = deliver(registry, [started("coder-1", 2, "run-2", "idle")]);
  assert.equal(registry.panels.length, 0);
  registry = deliver(registry, [{ ...action("coder-1"), correlation_id: "run-2" }]);
  assert.deepEqual(registry.panels.map((panel) => panel.agentId), ["coder-1"]);
  registry = closeCodingAgentPanel(registry, projectId, "coder-1");
  registry = deliver(registry, [started("coder-1", 1, "run-1"), started("coder-1", 3, "run-2")]);
  assert.equal(registry.panels.length, 0);
  registry = deliver(registry, [{ ...action("coder-1"), correlation_id: "run-3" }]);
  assert.deepEqual(registry.panels.map((panel) => panel.agentId), ["coder-1"]);
});

test("distinct started without correlation reopens; duplicates and missing evidence do not", () => {
  const first = started("coder-1", 1);
  let registry = deliver(createCodingAgentPanelRegistry(), [first]);
  registry = closeCodingAgentPanel(registry, projectId, "coder-1");
  const missing = { ...started("coder-1", 2), event_id: undefined, timestamp: undefined };
  registry = deliver(registry, [first, structuredClone(first), missing, action("coder-1")]);
  assert.equal(registry.panels.length, 0);
  const second = started("coder-1", 2);
  registry = deliver(registry, [second]);
  assert.equal(registry.panels.length, 1);
  registry = closeCodingAgentPanel(registry, projectId, "coder-1");
  registry = deliver(registry, [first, second]);
  assert.equal(registry.panels.length, 0);
});

test("closed policy survives delayed unique profile resolution and source invalidation", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-1")]);
  registry = closeCodingAgentPanel(registry, projectId, "coder-1");
  registry = deliver(registry, [action("coder-1")], []);
  registry = deliver(setCodingAgentPanelSource(registry, "connected"), [], agents);
  assert.equal(registry.panels.length, 0);
  registry = deliver(registry, [started("coder-1", 2)], [...agents, { ...agents[1] }]);
  assert.equal(registry.panels.length, 0);
  registry = deliver(registry, [], agents);
  assert.equal(registry.panels.length, 1);
});

test("AC-10: Sprint Plan component contracts and Coding ingress wiring remain intact", async () => {
  const monitor = await readFile(new URL("../components/coding-workspace-monitor.jsx", import.meta.url), "utf8");
  const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
  for (const [component, attributes] of [
    ["CodingArchitecturePlans", ["planEvents={planEvents}", "client={client}", "projectId={projectId}", "onHandoffCompleted={onRefresh}"]],
    ["SprintPlanDashboard", ["dashboard={dashboard}", "client={client}", "onRefresh={onRefresh}", "onSprintDeleted={onSprintDeleted}", "onTicketDeleted={onTicketDeleted}", "hideHeading", "defaultCollapsed"]]
  ]) {
    const tag = monitor.match(new RegExp(`<${component}\\b[^>]*?/>`))?.[0];
    assert.ok(tag);
    for (const attribute of attributes) assert.ok(tag.replace(/\s/g, "").includes(attribute.replace(/\s/g, "")));
  }
  assert.match(monitor, /key\s*=\s*\{panel\.key\}/);
  assert.match(page, /planEvents\.publish\(event\)/);
  assert.match(page, /updateCodingAgentPanelRegistry\(current,\s*PROJECT_ID,\s*\[event\]/);
  assert.match(page, /setWatcherState\s*:\s*setPanelSource/);
  const closeControl = monitor.match(/<button\b[^>]*>Close<\/button>/)?.[0];
  assert.ok(closeControl);
  assert.match(closeControl, /type\s*=\s*"button"/);
  assert.match(closeControl, /aria-label\s*=\s*\{`Close agent panel \$\{panel\.agentId\} in project \$\{panel\.projectId\}`\}/);
  assert.match(closeControl, /onAgentPanelClose\?\.\(panel\.projectId,\s*panel\.agentId\)/);
  assert.match(page, /closeCodingAgentPanel\(current,\s*projectId,\s*agentId\)/);
  assert.match(page, /onAgentPanelClose\s*=\s*\{onAgentPanelClose\}/);
});

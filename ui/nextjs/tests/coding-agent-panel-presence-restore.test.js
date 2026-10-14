// Extend the live Coding panel registry lifecycle with browser-local presence restoration: admitted identities, retained closures across reconnect, and buffer-only action refill.
import assert from "node:assert/strict";
import test from "node:test";
import {
  codingAgentPanelKey, codingAgentPanelActions, createCodingAgentPanelRegistry,
  updateCodingAgentPanelRegistry, setCodingAgentPanelSource, closeCodingAgentPanel
} from "../lib/coding-agent-panel-registry.js";
import {
  hydrateCodingAgentPanelRegistry, readCodingAgentPanelMembership, serializeCodingAgentPanelMembership
} from "../lib/coding-agent-panel-state.js";

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

// Model a started boundary using the existing activity contract, with optional run correlation.
function started(agentId, step, correlation, status = "working") {
  const event = action(agentId, status, projectId, step);
  return { ...event, ...(correlation ? { correlation_id: correlation } : {}),
    payload: { ...event.payload, activity_type: "started" } };
}

// Apply an event batch through the same boundary used at Coding stream delivery.
function deliver(registry, events, directory = agents, scope = projectId) {
  return updateCodingAgentPanelRegistry(registry, scope, events, directory);
}

// Round-trip a live registry through browser-local presence storage as the page does on reload.
function restorePresence(liveRegistry, directory = agents) {
  const saved = serializeCodingAgentPanelMembership(liveRegistry);
  const storage = { getItem: () => saved };
  const membership = readCodingAgentPanelMembership(() => storage, projectId, () => {});
  return hydrateCodingAgentPanelRegistry(createCodingAgentPanelRegistry(), membership, directory);
}

test("restored open and closed identities are admitted with their saved presence", () => {
  let live = deliver(createCodingAgentPanelRegistry(), [action("coder-1"), action("coder-2")]);
  live = deliver(live, [started("reviewer", 1, "run-1")]);
  live = closeCodingAgentPanel(live, projectId, "reviewer");
  const restored = restorePresence(live);
  assert.deepEqual(new Set(restored.panels.map((panel) => panel.agentId)), new Set(["coder-1", "coder-2"]));
  assert.equal(restored.closed[codingAgentPanelKey(projectId, "reviewer")], Infinity);
});

test("restored open identity admits only through a unique directory profile", () => {
  const saved = JSON.stringify({ version: 1, open: [[projectId, "coder-1"]], closed: [] });
  const membership = readCodingAgentPanelMembership(() => ({ getItem: () => saved }), projectId, () => {});
  const pending = hydrateCodingAgentPanelRegistry(createCodingAgentPanelRegistry(), membership, []);
  assert.equal(pending.panels.length, 0);
  assert.deepEqual(Object.keys(pending.pending), [codingAgentPanelKey(projectId, "coder-1")]);
  const admitted = hydrateCodingAgentPanelRegistry(pending, membership, agents);
  assert.deepEqual(admitted.panels.map((panel) => panel.agentId), ["coder-1"]);
  assert.equal(Object.keys(admitted.pending).length, 0);
});

test("restored closure survives reconnect and replayed buffered activity without reopening", () => {
  let live = deliver(createCodingAgentPanelRegistry(), [started("reviewer", 1, "run-1")]);
  live = closeCodingAgentPanel(live, projectId, "reviewer");
  let restored = restorePresence(live);
  for (const source of ["connecting", "connected", "error", "connected"]) {
    restored = setCodingAgentPanelSource(restored, source);
    restored = deliver(restored, [started("reviewer", 1, "run-1"), action("reviewer")]);
    assert.equal(restored.panels.some((panel) => panel.agentId === "reviewer"), false);
    assert.equal(restored.closed[codingAgentPanelKey(projectId, "reviewer")], Infinity);
  }
  // Reopen only once the closure is released to the current run version and a new boundary arrives.
  const reviewerKey = codingAgentPanelKey(projectId, "reviewer");
  restored.closed[reviewerKey] = restored.runs[reviewerKey].version;
  restored = deliver(restored, [started("reviewer", 2, "run-2")]);
  assert.equal(restored.panels.some((panel) => panel.agentId === "reviewer"), true);
});

test("restored panels refill actions only from the current shared buffer", () => {
  let live = deliver(createCodingAgentPanelRegistry(), [action("coder-1"), action("coder-2")]);
  const restored = restorePresence(live);
  const buffer = [action("coder-1"), action("reviewer"), action("coder-1", "working", "FOREIGN", 5)];
  assert.equal(restored.panels.length, 2);
  assert.deepEqual(codingAgentPanelActions(buffer, agents, projectId, "coder-1"), [buffer[0]]);
  assert.deepEqual(codingAgentPanelActions(buffer, agents, projectId, "coder-2"), []);
  assert.deepEqual(codingAgentPanelActions(buffer, agents, projectId, "reviewer"), [buffer[1]]);
});

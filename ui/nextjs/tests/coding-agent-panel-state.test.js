// Restore browser-local Coding panel presence: round trips, workspace partitioning, guarded storage, debounced writes, and REOPEN_NEXT_RUN lifecycle.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  closeCodingAgentPanel, codingAgentPanelKey, createCodingAgentPanelRegistry, updateCodingAgentPanelRegistry
} from "../lib/coding-agent-panel-registry.js";
import {
  CODING_PANEL_STATE_VERSION, applyCodingAgentPanelRunPolicy, codingAgentPanelMembership, codingAgentPanelStateKey,
  createCodingAgentPanelStatePersister, createInitialCodingAgentPanelRegistry, hydrateCodingAgentPanelRegistry,
  readCodingAgentPanelMembership, releaseRestoredPanelClosures, serializeCodingAgentPanelMembership
} from "../lib/coding-agent-panel-state.js";

const projectId = "PROJECT-1";
const agents = [
  { agent_id: "leader", agent_name: "Sprint Leader", role: "sprint_leader", status: "ready" },
  { agent_id: "coder-1", agent_name: "Coder", role: "coder", status: "ready" },
  { agent_id: "reviewer", agent_name: "Reviewer", role: "reviewer", status: "ready" }
];

// Build a controlled activity event carrying run, summary, tool, status, order, position and scroll fields that must never persist.
function action(agentId, status = "working", scope = projectId, step = 1) {
  return { project_id: scope, event_type: "agent.activity", event_id: `event-${agentId}-${step}`,
    timestamp: `2026-10-13T00:00:0${step}.000Z`, position: step * 24, scroll: step * 80,
    payload: { agent_id: agentId, status, summary: `${agentId} action ${step}`, activity_type: "tool_started",
      tool_name: "read_file", order: step } };
}

// Model a started boundary with optional run correlation using the existing activity contract.
function started(agentId, step, correlation, status = "working") {
  const event = action(agentId, status, projectId, step);
  return { ...event, ...(correlation ? { correlation_id: correlation } : {}),
    payload: { ...event.payload, activity_type: "started" } };
}

// Apply an event batch through the same registry boundary used at Coding stream delivery.
function deliver(registry, events, directory = agents, scope = projectId) {
  return updateCodingAgentPanelRegistry(registry, scope, events, directory);
}

// Rebuild a saved membership payload into a registry-like shape so membership helpers can re-read persisted presence.
function registryFrom(payload) {
  return {
    panels: payload.open.map(([pid, aid]) => ({ projectId: pid, agentId: aid, key: codingAgentPanelKey(pid, aid) })),
    closed: Object.fromEntries(payload.closed.map(([pid, aid]) => [codingAgentPanelKey(pid, aid), 0])),
    pending: {}, activity: {}, runs: {}, sourceStatus: "unknown"
  };
}

// In-memory browser-local storage double with controlled access.
function makeStorage(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (key) => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); } };
}

test("round trip persists identity presence only and restores panels and closures", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [action("coder-1"), action("reviewer")]);
  registry = deliver(registry, [started("leader", 1, "run-1")]);
  registry = closeCodingAgentPanel(registry, projectId, "leader");
  const membership = codingAgentPanelMembership(registry);
  assert.deepEqual(new Set(membership.open.map((pair) => pair[1])), new Set(["coder-1", "reviewer"]));
  assert.deepEqual(membership.closed, [[projectId, "leader"]]);
  const serialized = serializeCodingAgentPanelMembership(registry);
  const payload = JSON.parse(serialized);
  assert.deepEqual(Object.keys(payload).sort(), ["closed", "open", "version"]);
  assert.equal(payload.version, CODING_PANEL_STATE_VERSION);
  for (const pair of [...payload.open, ...payload.closed]) {
    assert.ok(Array.isArray(pair) && pair.length === 2);
    assert.equal(pair[0], projectId);
  }
  for (const needle of ["summary", "tool_name", "run", "position", "scroll", "order", "status"]) {
    assert.ok(!serialized.includes(needle), `serialized presence must not contain ${needle}`);
  }
  const storage = makeStorage();
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    createCodingAgentPanelStatePersister({ getStorage: () => storage, debounceMs: 400, log: () => {} })
      .save(projectId, registry);
    assert.equal(Object.keys(storage.data).length, 0);
    mock.timers.tick(400);
    assert.equal(storage.data[codingAgentPanelStateKey(projectId)], serialized);
  } finally {
    mock.timers.reset();
  }
  const restored = readCodingAgentPanelMembership(() => storage, projectId);
  assert.equal(restored.readable, true);
  assert.deepEqual(restored.open.map((entry) => entry.agentId).sort(), ["coder-1", "reviewer"]);
  assert.deepEqual(restored.closed.map((entry) => entry.agentId), ["leader"]);
  assert.deepEqual(restored.restoredClosed, [codingAgentPanelKey(projectId, "leader")]);
  const hydrated = hydrateCodingAgentPanelRegistry(createInitialCodingAgentPanelRegistry(), restored, agents);
  assert.deepEqual(new Set(hydrated.panels.map((panel) => panel.agentId)), new Set(["coder-1", "reviewer"]));
  assert.equal(hydrated.closed[codingAgentPanelKey(projectId, "leader")], Infinity);
});

test("keys partition saved presence per workspace and reject invalid workspaces", () => {
  assert.equal(codingAgentPanelStateKey(projectId), "nodeforge:coding:panel-state:PROJECT-1");
  assert.equal(codingAgentPanelStateKey("a b/c"), "nodeforge:coding:panel-state:a%20b%2Fc");
  assert.equal(codingAgentPanelStateKey(""), null);
  assert.equal(codingAgentPanelStateKey(null), null);
  const storage = makeStorage();
  const workspaceA = "PROJECT-A", workspaceB = "PROJECT-B";
  storage.data[codingAgentPanelStateKey(workspaceA)] = JSON.stringify({ version: CODING_PANEL_STATE_VERSION, open: [[workspaceA, "coder-1"]], closed: [] });
  storage.data[codingAgentPanelStateKey(workspaceB)] = JSON.stringify({ version: CODING_PANEL_STATE_VERSION, open: [], closed: [[workspaceB, "reviewer"]] });
  const a = readCodingAgentPanelMembership(() => storage, workspaceA);
  const b = readCodingAgentPanelMembership(() => storage, workspaceB);
  assert.deepEqual(a.open.map((entry) => entry.projectId), [workspaceA]);
  assert.deepEqual(a.closed, []);
  assert.deepEqual(b.closed.map((entry) => entry.projectId), [workspaceB]);
  assert.deepEqual(b.open, []);
});

test("saved identity pairs that are malformed, foreign, or duplicate are dropped", () => {
  const storage = makeStorage();
  storage.data[codingAgentPanelStateKey(projectId)] = JSON.stringify({
    version: CODING_PANEL_STATE_VERSION,
    open: [[projectId, "coder-1"], [projectId], [projectId, "bad id"], ["PROJECT-X", "reviewer"], 42, [projectId, ""]],
    closed: [[projectId, "reviewer"], [projectId, "leader"], [projectId, "leader"]]
  });
  const restored = readCodingAgentPanelMembership(() => storage, projectId);
  assert.equal(restored.readable, true);
  assert.deepEqual(restored.open.map((entry) => entry.agentId), ["coder-1"]);
  assert.deepEqual(restored.closed.map((entry) => entry.agentId), ["leader"]);
  assert.equal(restored.restoredOpen.length, 1);
});

test("restore without reopening keeps closures guarded through buffered and markerless activity", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [started("leader", 1, "run-1")]);
  registry = closeCodingAgentPanel(registry, projectId, "leader");
  const membership = codingAgentPanelMembership(registry);
  assert.deepEqual(membership.closed, [[projectId, "leader"]]);
  const hydrated = hydrateCodingAgentPanelRegistry(createInitialCodingAgentPanelRegistry(), membership, agents);
  assert.equal(hydrated.closed[codingAgentPanelKey(projectId, "leader")], Infinity);
  const buffered = deliver(hydrated, [action("leader", "working", projectId, 5)]);
  assert.equal(buffered.panels.length, 0);
  assert.equal(buffered.closed[codingAgentPanelKey(projectId, "leader")], Infinity);
  const applied = applyCodingAgentPanelRunPolicy(hydrated, projectId, [action("leader")], agents);
  assert.equal(applied.panels.length, 0);
  assert.equal(applied.closed[codingAgentPanelKey(projectId, "leader")], Infinity);
});

test("released restored closures reopen only at a later new-run boundary", () => {
  let registry = deliver(createCodingAgentPanelRegistry(), [started("leader", 1, "run-1")]);
  registry = closeCodingAgentPanel(registry, projectId, "leader");
  const leaderKey = codingAgentPanelKey(projectId, "leader");
  const membership = codingAgentPanelMembership(registry);
  const hydrated = hydrateCodingAgentPanelRegistry(createInitialCodingAgentPanelRegistry(), membership, agents);
  const released = releaseRestoredPanelClosures(hydrated, { restoredClosed: [leaderKey] });
  assert.equal(released.closed[leaderKey], 0);
  assert.equal(deliver(released, [started("leader", 1, "run-1")]).panels.length, 0);
  const reopened = applyCodingAgentPanelRunPolicy(released, projectId, [started("leader", 2, "run-2")], agents);
  assert.deepEqual(reopened.panels.map((panel) => panel.agentId), ["leader"]);
});

test("admission respects unique directory profiles and delayed directory via pending", () => {
  const storage = makeStorage();
  storage.data[codingAgentPanelStateKey(projectId)] = JSON.stringify({
    version: CODING_PANEL_STATE_VERSION,
    open: [[projectId, "coder-1"], [projectId, "reviewer"]],
    closed: []
  });
  const membership = readCodingAgentPanelMembership(() => storage, projectId);
  const hydrated = hydrateCodingAgentPanelRegistry(createInitialCodingAgentPanelRegistry(), membership, []);
  assert.equal(hydrated.panels.length, 0);
  assert.deepEqual(Object.keys(hydrated.pending).sort(), [codingAgentPanelKey(projectId, "coder-1"), codingAgentPanelKey(projectId, "reviewer")].sort());
  const admitted = hydrateCodingAgentPanelRegistry(hydrated, membership, agents);
  assert.deepEqual(new Set(admitted.panels.map((panel) => panel.agentId)), new Set(["coder-1", "reviewer"]));
  assert.equal(Object.keys(admitted.pending).length, 0);
  const foreignStorage = makeStorage();
  foreignStorage.data[codingAgentPanelStateKey(projectId)] = JSON.stringify({
    version: CODING_PANEL_STATE_VERSION, open: [["OTHER", "coder-1"]], closed: [] });
  assert.deepEqual(readCodingAgentPanelMembership(() => foreignStorage, projectId).open, []);
});

test("debounced writes coalesce, skip unchanged payloads, and flush pending on demand", () => {
  const storage = makeStorage();
  const errors = [];
  const persister = createCodingAgentPanelStatePersister({ getStorage: () => storage, debounceMs: 400, log: (error) => errors.push(error) });
  const open = deliver(createCodingAgentPanelRegistry(), [action("coder-1")]);
  const changed = deliver(open, [action("coder-1"), action("reviewer")]);
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    persister.save(projectId, open);
    assert.equal(Object.keys(storage.data).length, 0);
    mock.timers.tick(400);
    assert.deepEqual(codingAgentPanelMembership(registryFrom(JSON.parse(storage.data[codingAgentPanelStateKey(projectId)]))).open, [[projectId, "coder-1"]]);
    persister.save(projectId, open);
    assert.equal(codingAgentPanelMembership(registryFrom(JSON.parse(storage.data[codingAgentPanelStateKey(projectId)]))).open.length, 1);
    persister.save(projectId, open);
    persister.save(projectId, changed);
    mock.timers.tick(200);
    assert.equal(codingAgentPanelMembership(registryFrom(JSON.parse(storage.data[codingAgentPanelStateKey(projectId)]))).open.length, 1);
    mock.timers.tick(200);
    assert.deepEqual(new Set(codingAgentPanelMembership(registryFrom(JSON.parse(storage.data[codingAgentPanelStateKey(projectId)]))).open.map((pair) => pair[1])), new Set(["coder-1", "reviewer"]));
    persister.save(projectId, open);
    persister.flush();
    assert.deepEqual(codingAgentPanelMembership(registryFrom(JSON.parse(storage.data[codingAgentPanelStateKey(projectId)]))).open, [[projectId, "coder-1"]]);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(errors, []);
});

test("storage failures are logged and presence degrades without throwing", () => {
  const logs = [];
  const log = (error) => logs.push(error);
  assert.equal(readCodingAgentPanelMembership(() => null, projectId, log).readable, false);
  assert.equal(logs.length, 1);
  const throwingGet = makeStorage();
  throwingGet.getItem = () => { throw new Error("blocked"); };
  logs.length = 0;
  assert.equal(readCodingAgentPanelMembership(() => throwingGet, projectId, log).readable, false);
  assert.equal(logs.length, 1);
  const corrupt = makeStorage();
  corrupt.data[codingAgentPanelStateKey(projectId)] = "{not json";
  logs.length = 0;
  assert.equal(readCodingAgentPanelMembership(() => corrupt, projectId, log).readable, false);
  assert.equal(logs.length, 1);
  const wrongVersion = makeStorage();
  wrongVersion.data[codingAgentPanelStateKey(projectId)] = JSON.stringify({ version: CODING_PANEL_STATE_VERSION + 99, open: [], closed: [] });
  logs.length = 0;
  assert.equal(readCodingAgentPanelMembership(() => wrongVersion, projectId, log).readable, false);
  assert.equal(logs.length, 0);
  assert.equal(readCodingAgentPanelMembership(() => makeStorage(), projectId, log).readable, true);
  const writeFail = { getItem: () => null, setItem: () => { throw new Error("quota"); } };
  logs.length = 0;
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    createCodingAgentPanelStatePersister({ getStorage: () => writeFail, debounceMs: 400, log }).save(projectId, deliver(createCodingAgentPanelRegistry(), [action("coder-1")]));
    mock.timers.tick(400);
  } finally {
    mock.timers.reset();
  }
  assert.equal(logs.length, 1);
  assert.ok(logs[0] instanceof Error);
});

test("saved presence is restored before defaults so hydration never overwrites storage", async () => {
  const page = await readFile(new URL("../app/coding/page.jsx", import.meta.url), "utf8");
  assert.match(page, /panelsHydratedRef\.current = true;/);
  assert.match(page, /if \(!panelsHydratedRef\.current\) return;/);
  assert.ok(page.indexOf("restoredPanelMembershipRef.current = readCodingAgentPanelMembership") < page.indexOf("if (!panelsHydratedRef.current) return;"));
});

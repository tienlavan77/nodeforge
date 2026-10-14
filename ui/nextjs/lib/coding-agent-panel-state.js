// Restore Coding panel open/closed presence across reloads from browser-local storage without persisting run or activity data.

import {
  closeCodingAgentPanel,
  codingAgentPanelKey,
  codingAgentProfile,
  createCodingAgentPanelRegistry,
  updateCodingAgentPanelRegistry
} from "./coding-agent-panel-registry.js";

export const CODING_PANEL_STATE_VERSION = 1;

// Partition saved membership by workspace so one workspace's panels never leak into another.
export function codingAgentPanelStateKey(workspaceId) {
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  return `nodeforge:coding:panel-state:${encodeURIComponent(workspaceId)}`;
}

// Strip storage payloads to project and agent identity membership, dropping run markers, activity, order, position, and scroll.
function membershipEntries(registry) {
  const open = [];
  const closed = [];
  for (const panel of registry.panels) {
    const key = codingAgentPanelKey(panel.projectId, panel.agentId);
    if (key === panel.key) open.push([panel.projectId, panel.agentId]);
  }
  for (const key of Object.keys(registry.closed || {})) {
    let parsed;
    try {
      parsed = JSON.parse(key);
    } catch (error) {
      continue; // eslint-disable-next-line no-silent-catch -- unparseable runtime keys are registry internals, never saved membership
    }
    if (!Array.isArray(parsed)) continue;
    const memberKey = codingAgentPanelKey(parsed[0], parsed[1]);
    if (memberKey === key) closed.push([parsed[0], parsed[1]]);
  }
  return { open, closed };
}

// Serialize only identity membership for localStorage under the versioned storage schema.
export function serializeCodingAgentPanelMembership(registry) {
  const { open, closed } = membershipEntries(registry);
  return JSON.stringify({ version: CODING_PANEL_STATE_VERSION, open, closed });
}

// Rebuild identity membership from registry state for persistence callers.
export function codingAgentPanelMembership(registry) {
  return membershipEntries(registry);
}

// Validate one saved identity pair and reject malformed entries before they reach the registry.
function savedIdentityPair(entry, currentWorkspaceId) {
  if (!Array.isArray(entry) || entry.length !== 2) return null;
  const [projectId, agentId] = entry;
  if (typeof projectId !== "string" || projectId !== currentWorkspaceId) return null;
  if (!codingAgentPanelKey(projectId, agentId)) return null;
  return { key: codingAgentPanelKey(projectId, agentId), projectId, agentId };
}

// Read saved membership with guarded accessor storage access, keeping only identity pairs that pass validation.
export function readCodingAgentPanelMembership(getStorage, workspaceId, log = () => {}) {
  const storageKey = codingAgentPanelStateKey(workspaceId);
  if (!storageKey) return { open: [], closed: [], restoredOpen: [], restoredClosed: [], readable: false };
  let raw;
  try {
    const storage = getStorage();
    if (!storage) throw new Error("Browser-local storage is unavailable");
    raw = storage.getItem(storageKey) ?? null;
  } catch (error) {
    log(error);
    return { open: [], closed: [], restoredOpen: [], restoredClosed: [], readable: false };
  }
  if (raw === null || raw === undefined) return { open: [], closed: [], readable: true };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    log(error);
    return { open: [], closed: [], restoredOpen: [], restoredClosed: [], readable: false };
  }
  if (!payload || payload.version !== CODING_PANEL_STATE_VERSION) return { open: [], closed: [], restoredOpen: [], restoredClosed: [], readable: false };
  const collect = (rows) => {
    const keys = new Map();
    for (const entry of Array.isArray(rows) ? rows : []) {
      const identity = savedIdentityPair(entry, workspaceId);
      if (identity) keys.set(identity.key, identity);
    }
    return keys;
  };
  const open = collect(payload.open);
  const closed = collect(payload.closed);
  for (const key of open.keys()) closed.delete(key);
  return {
    open: [...open.values()],
    closed: [...closed.values()],
    restoredOpen: [...open.keys()],
    restoredClosed: [...closed.keys()],
    readable: true
  };
}

// Adopt saved presence before defaults, admitting open panels only through unique directory profiles and holding restored closures against buffered replay.
export function hydrateCodingAgentPanelRegistry(registry, membership, agents) {
  const closed = { ...registry.closed };
  for (const entry of membership.restoredClosed || []) closed[entry] = Infinity;
  const panels = [...registry.panels];
  const admittedKeys = new Set(panels.map((panel) => panel.key));
  const pending = { ...registry.pending };
  for (const identity of membership.open) {
    if (admittedKeys.has(identity.key)) continue;
    if (!codingAgentProfile(agents, identity.agentId, identity.projectId)) {
      if (closed[identity.key] === undefined) pending[identity.key] = identity;
      continue;
    }
    delete pending[identity.key];
    panels.push(identity);
    admittedKeys.add(identity.key);
  }
  return { ...registry, panels, pending, closed };
}

// Reveal a restored closure to future new-run boundaries only after buffered activity has been absorbed as run evidence.
export function releaseRestoredPanelClosures(registry, membership) {
  const closed = { ...registry.closed };
  for (const key of membership?.restoredClosed || []) {
    if (closed[key] !== Infinity) continue;
    closed[key] = registry.runs?.[key]?.version ?? 0;
  }
  return { ...registry, closed };
}

// Persist identity membership after the debounce window with guarded writes so storage failures never break the UI.
export function createCodingAgentPanelStatePersister({ getStorage, debounceMs = 400, log = () => {} }) {
  let timer = null;
  let pendingKey = null;
  let pendingPayload = null;
  let lastWrittenKey = null;
  let lastWrittenPayload = null;

  // Write the pending membership payload through guarded storage access and remember it to suppress repeats.
  function write() {
    if (pendingKey === null || pendingPayload === null) return;
    try {
      getStorage().setItem(pendingKey, pendingPayload);
      lastWrittenKey = pendingKey;
      lastWrittenPayload = pendingPayload;
    } catch (error) {
      log(error);
    }
  }

  // Coalesce membership writes per workspace and collapse unchanged payloads.
  function schedule(workspaceId, membership) {
    const storageKey = codingAgentPanelStateKey(workspaceId);
    if (!storageKey) return;
    const payload = JSON.stringify({
      version: CODING_PANEL_STATE_VERSION,
      open: membership.open,
      closed: membership.closed
    });
    if (storageKey === lastWrittenKey && payload === lastWrittenPayload) return;
    pendingKey = storageKey;
    pendingPayload = payload;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      write();
    }, debounceMs);
  }

  // Save current registry membership for a workspace partition.
  function save(workspaceId, registry) {
    schedule(workspaceId, codingAgentPanelMembership(registry));
  }

  // Flush a pending write immediately so navigation or close does not lose the last change.
  function flush() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    write();
  }

  // Discard any scheduled write when the page unmounts.
  function cancel() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { save, flush, cancel };
}

// Apply the REOPEN_NEXT_RUN owner policy: a new run boundary reopens a closed panel, while same-run or markerless activity keeps it closed.
export function applyCodingAgentPanelRunPolicy(registry, workspaceId, events, agents) {
  let next = updateCodingAgentPanelRegistry(registry, workspaceId, events, agents);
  for (const panel of [...next.panels]) {
    if (panel.projectId !== workspaceId) continue;
    const profile = codingAgentProfile(agents, panel.agentId, panel.projectId);
    if (profile) continue;
    next = closeCodingAgentPanel(next, panel.projectId, panel.agentId);
  }
  return next;
}

// Start each Coding page session with a fresh in-memory registry before saved membership is read.
export function createInitialCodingAgentPanelRegistry() {
  return createCodingAgentPanelRegistry();
}

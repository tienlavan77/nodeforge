// Verifies the Agents directory settles bounded reads, retries without reload and preserves newer live statuses.
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentDirectoryLoader, mergeAgentProfiles, normalizeAgentDirectory } from "../lib/agent-directory-loader.js";

// Isolates fetch behavior and captures directory state without mounting an unrelated application shell.
function fixture(context, fetcher, timeoutMs = 1000) {
  const previous = globalThis.fetch;
  context.after(() => { globalThis.fetch = previous; });
  globalThis.fetch = fetcher;
  const states = []; const profiles = [];
  const loader = createAgentDirectoryLoader({ url: "/forge/v1/agents", timeoutMs, onProfiles: (value) => profiles.push(value), onState: (status, error) => states.push({ status, error }) });
  return { loader, states, profiles };
}

test("valid directory load becomes ready without cached profiles or malformed empty success", async (context) => {
  const { loader, states, profiles } = fixture(context, async (url, init) => { assert.equal(url, "/forge/v1/agents"); assert.equal(init.cache, "no-store"); assert.ok(init.signal); return new Response(JSON.stringify({ agents: [{ agent_id: "A" }] })); });
  await loader.load();
  assert.deepEqual(states.map((value) => value.status), ["loading", "ready"]);
  assert.equal(profiles[0][0].agent_id, "A");
  assert.deepEqual(normalizeAgentDirectory({ items: [] }), []);
  assert.deepEqual(normalizeAgentDirectory([]), []);
  for (const payload of [null, {}, { error: "unavailable" }]) assert.throws(() => normalizeAgentDirectory(payload), /invalid directory/);
});

test("timeout exits Loading and Retry recovers without reloading the page", async (context) => {
  let hanging = true;
  const { loader, states, profiles } = fixture(context, async (url, { signal }) => hanging ? new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) : new Response("[]"), 10);
  await loader.load();
  assert.equal(states.at(-1).status, "error"); assert.match(states.at(-1).error, /timed out/);
  hanging = false; await loader.load();
  assert.equal(states.at(-1).status, "ready"); assert.deepEqual(profiles.at(-1), []);
});

test("HTTP and malformed-body failures remain actionable rather than permanently loading", async (context) => {
  const { loader, states } = fixture(context, async () => new Response(JSON.stringify({ error: { code: "UNAVAILABLE", message: "Control API unavailable" } }), { status: 503 }));
  await loader.load(); assert.equal(states.at(-1).status, "error"); assert.match(states.at(-1).error, /Control API unavailable/);
  globalThis.fetch = async () => new Response("invalid JSON");
  await loader.load(); assert.equal(states.at(-1).status, "error");
});

test("reconnect can settle the initial state and stale responses cannot overwrite its result", async (context) => {
  const requests = [];
  const { loader, states, profiles } = fixture(context, async () => new Promise((resolve) => requests.push(resolve)));
  const initial = loader.load(); const reconnect = loader.load();
  requests[1](new Response('[{"agent_id":"NEW"}]')); await reconnect;
  requests[0](new Response('[{"agent_id":"OLD"}]')); await initial;
  assert.equal(profiles.length, 1); assert.equal(profiles[0][0].agent_id, "NEW"); assert.equal(states.at(-1).status, "ready");
});

test("unmount cancels reads without updating an abandoned page", async (context) => {
  const { loader, states, profiles } = fixture(context, async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })));
  const request = loader.load(); loader.cancel(); await request;
  assert.equal(states.length, 1); assert.equal(profiles.length, 0);
});

test("failed background refresh retains loaded profiles and never resets the directory to Loading", async (context) => {
  const { loader, states, profiles } = fixture(context, async () => new Response('[{"agent_id":"A"}]'), 10);
  await loader.load();
  globalThis.fetch = async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  await loader.load();
  assert.deepEqual(states.map((value) => value.status), ["loading", "ready", "error"]);
  assert.equal(profiles.length, 1); assert.equal(profiles[0][0].agent_id, "A");
});

test("refresh retains newer stream statuses while accepting updated profile configuration", () => {
  const current = [{ agent_id: "A", status: "working", updated_at: "2026-10-13T12:01:00Z" }];
  const incoming = [{ agent_id: "A", agent_name: "Updated name", status: "ready", updated_at: "2026-10-13T12:00:00Z" }];
  const [agent] = mergeAgentProfiles(current, incoming);
  assert.equal(agent.agent_name, "Updated name"); assert.equal(agent.status, "working");
});

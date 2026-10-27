/**
 * Verifies the real Ideas transport through immutable project selection binding.
 * Exact URL and body assertions protect the independent item contract from generic
 * project injection, while stale-generation tests prevent obsolete callbacks from
 * submitting or publishing results. Existing client operation shapes remain compatible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createIdeasClient } from "../lib/ideas-client.js";
import { createNodeClient } from "../lib/node-client.js";
import { bindProjectClient, refreshProjects, selectProject } from "../lib/project-selection.js";

/** Admit two deterministic projects through the production selection store's actual HTTP boundary. */
async function admit() {
  globalThis.fetch = async () => Response.json({ projects: [{ project_id: "A" }, { project_id: "B" }] });
  await refreshProjects();
  selectProject("A");
}

test("Ideas CRUD preserves collection ownership and independent versioned item contracts", async () => {
  await admit();
  const calls = [];
  const client = bindProjectClient(createIdeasClient({
    url: (path) => "/forge/v1" + path,
    request: async (url, init = {}) => { calls.push({ url, ...init }); return { id: "id /1", version: 2 }; }
  }));
  const options = { projectId: "B", content: "Draft" };
  await client.listIdeas({ projectId: "B" });
  await client.listIdeas({ status: "done" });
  await client.createIdea(options);
  await client.getIdea({ id: "id /1" });
  await client.updateIdea({ id: "id /1", content: "Revised", status: "done", expected_version: 2, project_id: "B", project: "B" });
  await client.updateIdea({ id: "id /1", status: "open", expected_version: 3 });
  await client.deleteIdea({ id: "id /1", expected_version: 4 });
  assert.equal(options.projectId, "B");
  assert.equal(calls[0].url, "/forge/v1/ideas?project_id=A&status=all");
  assert.equal(calls[1].url, "/forge/v1/ideas?project_id=A&status=done");
  assert.deepEqual(JSON.parse(calls[2].body), { project_id: "A", content: "Draft" });
  assert.equal(calls[2].method, "POST");
  assert.equal(calls[3].url, "/forge/v1/ideas/id%20%2F1");
  assert.equal(calls[4].url, calls[3].url);
  assert.equal(calls[4].method, "PATCH");
  assert.deepEqual(JSON.parse(calls[4].body), { content: "Revised", status: "done", expected_version: 2 });
  assert.deepEqual(JSON.parse(calls[5].body), { status: "open", expected_version: 3 });
  assert.equal(calls[6].url, "/forge/v1/ideas/id%20%2F1?expected_version=4");
  assert.equal(calls[6].method, "DELETE");
  assert.equal(calls[6].body, undefined);
});

test("every captured Ideas callback rejects a stale project before invoking transport", async () => {
  await admit();
  let requests = 0;
  const client = bindProjectClient(createIdeasClient({ request: async () => { requests++; return []; } }));
  const callbacks = Object.values(client);
  selectProject("B");
  for (const callback of callbacks) assert.throws(() => callback({ id: "x", expected_version: 1 }), { code: "STALE_PROJECT_SELECTION" });
  assert.equal(requests, 0);
});

test("a late Ideas response rejects with STALE_PROJECT_SELECTION", async () => {
  await admit();
  let resolve;
  const client = bindProjectClient(createIdeasClient({ request: () => new Promise((done) => { resolve = done; }) }));
  const pending = client.listIdeas({});
  selectProject("B"); resolve([]);
  await assert.rejects(pending, { code: "STALE_PROJECT_SELECTION" });
});

test("binding guards supplied callbacks and preserves unrelated object, positional and global shapes", async () => {
  await admit();
  let callback;
  const client = bindProjectClient({
    listConversations(options) { callback = options.onResult; return options; },
    getTicket(projectId, id) { return [projectId, id]; },
    getAgents(role) { return role; }
  });
  let delivered = 0;
  const original = { projectId: "B", agentId: "agent-1", onResult: () => { delivered++; } };
  const result = client.listConversations(original);
  assert.equal(result.projectId, "A"); assert.equal(result.agentId, "agent-1");
  assert.equal(original.projectId, "B");
  callback(); assert.equal(delivered, 1);
  assert.deepEqual(client.getTicket("B", "TICKET-1"), ["A", "TICKET-1"]);
  assert.equal(client.getAgents("architecture_manager"), "architecture_manager");
  selectProject("B"); callback(); assert.equal(delivered, 1);
});

test("createNodeClient exposes the production Ideas operations through project binding", async () => {
  await admit();
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return Response.json({ id: "idea-1", version: 1 }); };
  const client = createNodeClient();
  await client.createIdea({ content: "Integrated" });
  await client.getIdea({ id: "idea-1" });
  assert.deepEqual(JSON.parse(calls[0].init.body), { project_id: "A", content: "Integrated" });
  assert.ok(calls[1].url.endsWith("/forge/v1/ideas/idea-1"));
});

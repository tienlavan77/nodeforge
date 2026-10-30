// Verify every selected-project client operation, lifecycle payload, stale completion, and stream cleanup.
import assert from "node:assert/strict";
import test from "node:test";
import { createNodeClient } from "../lib/node-client.js";
import { addProject, clearProjectSelection, getProjectSelection, refreshProjects, removeProject, selectProject } from "../lib/project-selection.js";
import * as workspaceKeys from "../lib/home-page-constants.js";

// Exercise the real client against controlled HTTP and SSE boundaries, never live project workloads.
test("selected identity covers all client requests and isolates switched or unavailable workspaces", async (context) => {
  const calls = [];
  const sources = [];
  let projects = [{ project_id: "PROJECT-A", root: "/a" }];
  let delayed = null;
  let unavailable = false;
  context.mock.method(globalThis, "fetch", async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, method: init.method ?? "GET" });
    if (url.pathname.endsWith("/lifecycle/list")) { assert.equal(url.pathname, "/lifecycle/list"); return Response.json({ projects }); }
    if (url.pathname.endsWith("/lifecycle/add")) {
      assert.deepEqual(body, { root: "/b" });
      projects = [...projects, { project_id: "PROJECT-B", root: body.root }];
      return Response.json(projects.at(-1));
    }
    if (url.pathname.endsWith("/lifecycle/remove")) {
      assert.deepEqual(body, { root: "/b" });
      projects = projects.filter((project) => project.root !== body.root);
      return Response.json({ removed: true, root: body.root });
    }
    if (unavailable) return Response.json({ error: { code: "PROJECT_NOT_FOUND", message: "Project is unavailable." } }, { status: 404 });
    if (delayed) return new Promise((resolve) => { delayed.resolve = resolve; });
    return Response.json({ items: [], version: 1, project_id: getProjectSelection().projectId });
  });
  const originalSource = globalThis.EventSource;
  // Retain closed listeners to prove queued old-socket delivery is rejected by production code.
  globalThis.EventSource = class {
    constructor(url) { this.url = new URL(url); this.readyState = 1; this.handlers = new Map(); this.closed = false; sources.push(this); }
    addEventListener(type, handler) { this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]); }
    close() { this.closed = true; this.readyState = 2; }
    emit(type, value) { for (const handler of this.handlers.get(type) ?? []) handler({ data: JSON.stringify(value), lastEventId: value.event_id }); }
  };
  context.after(() => { globalThis.EventSource = originalSource; });
  await refreshProjects({ selectInitial: false });
  assert.equal(getProjectSelection().projectId, null, "the directory does not select even a sole configured project");
  selectProject("PROJECT-A");
  assert.equal(getProjectSelection().projectId, "PROJECT-A", "opening the project card admits that project");
  const oldClient = createNodeClient();
  const oldEvents = [];
  oldClient.connectProjectStream({ projectId: "wrong", onEvent: (event) => oldEvents.push(event) });
  oldClient.connectConversationStream({ projectId: "wrong", conversationId: "conversation", onMessage: (event) => oldEvents.push(event) });
  delayed = {};
  const pending = oldClient.getProjectDashboard("wrong");
  const rejected = assert.rejects(pending, { code: "STALE_PROJECT_SELECTION" });
  const held = delayed;
  delayed = null;
  await addProject("/b");
  assert.equal(getProjectSelection().projectId, "PROJECT-A", "addition does not silently change selection");
  selectProject("PROJECT-B");
  assert.equal(workspaceKeys.PROJECT_ID, "PROJECT-B");
  assert.equal(workspaceKeys.CHAT_STATE_KEY, "nodeforge:chat:last:PROJECT-B");
  assert.ok(sources.every((source) => source.closed), "switch closes both subscription types");
  held.resolve(Response.json({ project_id: "PROJECT-A", stale: true }));
  await rejected;
  for (const source of sources) source.emit("conversation.message.received", { event_id: "old", event_type: "conversation.message.received", schema_version: 1, project_id: "PROJECT-A", timestamp: "now", payload: {}, message_id: "old" });
  assert.deepEqual(oldEvents, []);
  assert.throws(() => oldClient.createTicket("PROJECT-A", "old work", "sprint"), { code: "STALE_PROJECT_SELECTION" });

  const client = createNodeClient();
  const plan = { plan_id: "plan", sprint_id: "sprint", revision: 1, sha256: "hash", source_sha256: "hash", source_path: "plan.md" };
  const session = { session_id: "session", version: 1, source_sha256: "hash" };
  const object = { projectId: "wrong", conversationId: "conversation", agentId: "agent", title: "Title", text: "Hello", decisionId: "decision", messageId: "message" };
  const operations = {
    listIdeas: [object], createIdea: [{ ...object, content: "New idea" }], getIdea: [{ ...object, id: "idea" }],
    updateIdea: [{ ...object, id: "idea", content: "Updated", expected_version: 1 }], deleteIdea: [{ ...object, id: "idea", expected_version: 1 }],
    createConversation: [object], listConversations: [object], getGitStatus: ["wrong"], commitAndPush: ["wrong", "Commit"], getMarkdownFile: ["wrong", "README.md"],
    postHumanDecision: [object], getConversationAuditHistory: [object], getProjectDashboard: ["wrong"], getTicket: ["wrong", "ticket"], createTicket: ["wrong", "Task", "sprint"], getTicketGraph: ["wrong", "ticket"],
    uploadSprintPlan: ["wrong", {}], listSprints: ["wrong"], getSprintPlan: ["wrong", "sprint"], draftSprintPlan: ["wrong", "sprint"], listPlanRequests: ["wrong"], listPlans: ["wrong"], createPlan: ["wrong", "plan", "sprint", "Plan"],
    revisePlan: ["wrong", plan, "Plan"], getPlanRevision: ["wrong", "plan", 1], listSprintRegistry: ["wrong"], registerSprint: ["wrong", "sprint", 1, [], plan], getSprintRegistry: ["wrong", "sprint"],
    handoffPlan: ["wrong", plan, "token"], decidePlan: ["wrong", plan, "approve", "token"], bindSprintPlan: ["wrong", "sprint", plan], setSprintStatus: ["wrong", "sprint", "ready"], updateSprintPlan: ["wrong", "sprint", {}, 1],
    addTicketToSprint: ["wrong", "sprint", {}], deleteSprintPlan: ["wrong", "sprint"], deleteTicket: ["wrong", "ticket"], regenerateTicketEnglish: ["wrong", "ticket", {}], runTicket: ["wrong", "ticket"], stopTicket: ["wrong", "ticket"],
    runCode: ["wrong", "sprint", "Task"], listCodeCheckpoints: ["wrong", "sprint"], resumeCode: ["wrong", "task"], runSprint: ["wrong", "sprint"], runSprintPlan: ["wrong", "sprint"], getArchitectureWorkspace: ["wrong"],
    postOwnerMessage: [object], getConversationMessages: [object], saveConversationMarkdown: [object],
    respondTicketBlocker: ["wrong", "ticket", { request_id: "request", job_id: "job", execution_id: "execution", answer: "Answer", token: "test-token" }],
    getTicketHumanReview: ["wrong", "ticket"], approveTicketHumanReview: ["wrong", "ticket", { actor: "owner", reason: "Reason" }], decideTicketBlocker: ["wrong", "ticket", { actor: "owner", reason: "Reason", optionId: "option" }],
    listOwnerExecutions: ["wrong", "conversation"], decideOwnerExecution: ["wrong", "conversation", "execution", "pause"], reconcileOwnerExecution: ["wrong", "conversation", "execution", 1],
    listArchitectureClarifications: ["wrong", "conversation"], saveArchitectureChoices: ["wrong", "conversation", session, {}, "Notes", "token"], confirmArchitectureChoices: ["wrong", "conversation", session, "token"]
  };
  const globalNames = ["getAgents", "getAgent", "createAgent", "saveAgentSettings", "testAgentConnection", "sendOwnerMessage", "stream"];
  assert.deepEqual(Object.keys(client).sort(), [...Object.keys(operations), ...globalNames, "connectProjectStream", "connectConversationStream"].sort(), "every project-bound operation must have an executable regression case");
  for (const [name, args] of Object.entries(operations)) {
    const start = calls.length;
    await client[name](...args);
    assert.ok(calls.length > start, `${name} sends a real request`);
    for (const call of calls.slice(start)) {
      const pathProject = /^\/forge\/v1\/projects\/([^/]+)/.exec(call.url.pathname)?.[1];
      if (["getIdea", "updateIdea", "deleteIdea"].includes(name)) {
        assert.equal(call.url.pathname, "/forge/v1/ideas/idea", `${name} addresses its independent Idea ID`);
        assert.equal(call.body?.project_id, undefined, "item mutations must retain their contract allowlist");
      } else assert.equal(pathProject ?? call.url.searchParams.get("project") ?? call.url.searchParams.get("project_id") ?? call.body?.project_id, "PROJECT-B", `${name} binds B using its existing shape`);
      if (call.body && "project_id" in call.body) assert.equal(call.body.project_id, "PROJECT-B", `${name} body matches URL`);
      assert.ok(!call.url.href.includes("wrong"), `${name} removes obsolete project context`);
    }
  }
  const currentEvents = [];
  const stream = client.connectProjectStream({ projectId: "wrong", onEvent: (event) => currentEvents.push(event) });
  const conversationStream = client.connectConversationStream({ projectId: "wrong", conversationId: "conversation", onMessage: (event) => currentEvents.push(event) });
  assert.ok(sources.slice(-2).every((source) => source.url.searchParams.get("project") === "PROJECT-B"));
  sources.at(-2).emit("stream.connected", { event_id: "b", event_type: "stream.connected", schema_version: 1, project_id: "PROJECT-B", timestamp: "now", payload: {} });
  assert.equal(currentEvents.length, 1, "current project events still work");
  clearProjectSelection();
  assert.equal(getProjectSelection().projectId, null, "returning home clears the active project");
  assert.ok(sources.every((source) => source.closed), "the global directory owns no project streams");
  await refreshProjects({ selectInitial: false });
  assert.equal(getProjectSelection().projectId, null, "refreshing the directory keeps project selection explicit");
  selectProject("PROJECT-B");
  stream.close(); conversationStream.close();
  assert.ok(sources.every((source) => source.closed));
  await removeProject("/b");
  assert.equal(getProjectSelection().projectId, null);
  assert.match(getProjectSelection().error, /unavailable/);
  const before = calls.length;
  assert.throws(() => createNodeClient().createTicket("PROJECT-A", "Task"), /Select an available project/);
  assert.equal(calls.length, before, "no fallback request is sent");
  selectProject("PROJECT-A");
  unavailable = true;
  await assert.rejects(createNodeClient().getProjectDashboard("PROJECT-A"), { code: "project_not_found" });
  assert.equal(getProjectSelection().projectId, null, "server loss enters recoverable state");
});

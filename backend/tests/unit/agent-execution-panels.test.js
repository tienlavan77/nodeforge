// Verifies real execution activity traverses project SSE and the browser client to open exact Coding agent panels.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createAgentExecutionActivity, createAgentActivityLogger } from "../../src/application/agent-execution-activity.js";
import { createRuntimeLogger } from "../../src/core/runtime-logger.js";
import { formatToolLogEvent } from "../../src/tools/tool-log-event.js";
import { createRoleSdkGateway } from "../../scripts/control-api-platform.mjs";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";
import { createProjectStreamClient } from "../../../ui/nextjs/lib/project-stream-client.js";
import { createCodingAgentPanelRegistry, updateCodingAgentPanelRegistry, closeCodingAgentPanel, codingAgentPanelActions } from "../../../ui/nextjs/lib/coding-agent-panel-registry.js";

const projectId = "PROJECT-PANELS";
const directory = [{ agent_id: "SL-1", role: "sprint_leader" }, { agent_id: "CODER-1", role: "coder" }, { agent_id: "REVIEWER-1", role: "reviewer" }];

test("approval retry notice reaches the Coder SSE panel as waiting work with no denial payload", (context) => {
  const state = fixture(context);
  state.activity.recordToolEvent({ event_name: "supervisor.approval_retry_scheduled", correlation_id: "RUN-CODER",
    message: "Dịch vụ duyệt lỗi 503; retry mỗi 30 giây. Nhấn Stop để dừng.", payload: { agent_id: "CODER-1", receipts: [{ error: "PRIVATE" }] } });
  const event = state.received.at(-1);
  assert.equal(event.payload.status, "working");
  assert.match(event.payload.summary, /30 giây.*Stop/);
  assert.equal(JSON.stringify(event).includes("PRIVATE"), false);
});

// Connects backend activity through the actual SSE projection, client filtering, and panel registry without a provider process.
function fixture(context, initialDirectory = directory, beforeConnect) {
  const original = globalThis.EventSource;
  let source;
  globalThis.EventSource = class {
    constructor() { this.handlers = new Map(); source = this; }
    addEventListener(type, handler) { this.handlers.set(type, handler); }
    close() {}
  };
  let registry = createCodingAgentPanelRegistry();
  let agents = initialDirectory;
  const received = [];
  const client = createProjectStreamClient(() => "/stream");
  const subscription = client({ projectId, onEvent: (event) => {
    received.push(event);
    registry = updateCodingAgentPanelRegistry(registry, projectId, [event], agents);
  } });
  const eventBus = new EventEmitter();
  const activity = createAgentExecutionActivity({ projectId, eventBus });
  beforeConnect?.(activity);
  const stream = createProjectStream({ projectId, eventBus, agentActivitySnapshot: activity.snapshot, indexDb: { all: () => [] }, subscriptions: { subscribe: () => ({}), unsubscribe: () => {} } });
  const response = { writeHead() {}, write: (chunk) => {
    if (!chunk.startsWith("id: ")) return;
    const event = JSON.parse(chunk.split("data: ")[1]);
    source.handlers.get(event.event_type)?.({ data: JSON.stringify(event), lastEventId: event.event_id });
  }, end() {} };
  const connection = stream.connect({ requestedProjectId: projectId, response });
  context.after(() => { connection.close(); subscription.close(); globalThis.EventSource = original; });
  return { activity, eventBus, received, get registry() { return registry; },
    close: (agentId) => { registry = closeCodingAgentPanel(registry, projectId, agentId); },
    setDirectory: (next) => { agents = next; registry = updateCodingAgentPanelRegistry(registry, projectId, [], agents); } };
}

// Opens every supported role only when actual working activity arrives and retains panels after work ends.
test("SL, Coder and Reviewer execution activity opens three isolated panels through SSE", (context) => {
  const state = fixture(context);
  for (const agent of directory) state.activity({ agentId: agent.agent_id, correlationId: `RUN-${agent.agent_id}`, phase: "started" });
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), directory.map((agent) => agent.agent_id));
  for (const agent of directory) state.activity({ agentId: agent.agent_id, correlationId: `RUN-${agent.agent_id}`, phase: "completed" });
  assert.equal(state.registry.panels.length, 3);
  assert.equal(state.received.filter((event) => event.event_type === "agent.activity").length, 6);
  assert(Object.values(state.registry.activity).every((status) => status === "success"));
});

// Keeps a manually closed panel closed for the same claim and reopens it only for a new execution claim.
test("same-run activity respects close while a new claim reopens only that agent", (context) => {
  const state = fixture(context);
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
  state.activity({ agentId: "REVIEWER-1", correlationId: "CLAIM-REVIEW", phase: "started" });
  state.close("CODER-1");
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), ["REVIEWER-1"]);
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-2", phase: "started" });
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), ["REVIEWER-1", "CODER-1"]);
});

// Retains unknown directory evidence without attributing work prematurely, and rejects cross-project events.
test("delayed profiles and foreign project activity do not misattribute panels", (context) => {
  const state = fixture(context, []);
  state.activity({ agentId: "SL-1", correlationId: "RUN-SL", phase: "started" });
  assert.equal(state.registry.panels.length, 0);
  state.setDirectory(directory);
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), ["SL-1"]);
  createAgentExecutionActivity({ projectId: "PROJECT-OTHER", eventBus: state.eventBus })({ agentId: "CODER-1", correlationId: "FOREIGN", phase: "started" });
  assert.equal(state.registry.panels.length, 1);
});

// Publishes the actual SL SDK boundaries so its panel opens before planning resolves and failure does not leave it working.
test("SL SDK invocation opens its panel before dispatch and reports success or failure", async (context) => {
  const state = fixture(context);
  const profile = { agent_id: "SL-1", role: "sprint_leader", provider: "codex" };
  let fail = false;
  const gateway = createRoleSdkGateway({ codexSdkGateway: { execute: async () => {
    assert(state.registry.panels.some((panel) => panel.agentId === "SL-1"));
    if (fail) throw Object.assign(new Error("Provider unavailable"), { code: "PROVIDER_OFFLINE" });
    return { text: "Plan drafted" };
  } }, agentRoleResolver: { resolveProfile: () => profile }, onActivity: state.activity });
  await gateway.execute({ agentId: profile.agent_id, correlationId: "PLAN-1", prompt: "Private owner context" });
  fail = true;
  await assert.rejects(gateway.execute({ agentId: profile.agent_id, correlationId: "PLAN-2", prompt: "Private owner context" }), { code: "PROVIDER_OFFLINE" });
  assert.deepEqual(state.received.filter((event) => event.event_type === "agent.activity").map((event) => event.payload.activity_type), ["started", "completed", "started", "failed"]);
  assert.equal(JSON.stringify(state.received).includes("Private owner context"), false);
});

// Logs transport failures rather than interrupting real SDK work or emitting activity with missing ownership.
test("activity publication is best-effort and requires explicit execution identity", () => {
  const errors = [];
  const activity = createAgentExecutionActivity({ projectId, eventBus: { emit: () => { throw new Error("Listener failed"); } }, logger: { error: (...args) => errors.push(args) } });
  activity({ agentId: "CODER-1", phase: "started" });
  assert.equal(errors.length, 0);
  assert.doesNotThrow(() => activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" }));
  assert.equal(errors.length, 1);
});

// Replays only currently executing work when Coding opens or reconnects, never completed activity or directory guesses.
test("connecting during execution opens active panels without replaying completed work", (context) => {
  const state = fixture(context, directory, (activity) => {
    activity({ agentId: "SL-1", correlationId: "PLAN-1", phase: "started" });
    activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
    activity({ agentId: "REVIEWER-1", correlationId: "REVIEW-1", phase: "started" });
    activity({ agentId: "REVIEWER-1", correlationId: "REVIEW-1", phase: "completed" });
  });
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), ["SL-1", "CODER-1"]);
  assert.equal(state.activity.snapshot().length, 2);
  const snapshot = state.activity.snapshot();
  snapshot[0].payload.agent_id = "OTHER";
  assert.equal(state.activity.snapshot()[0].payload.agent_id, "SL-1");
});

// Exercises the real runtime-log boundary and SSE pipeline instead of injecting browser-only tool activity.
test("audited SL, Coder and Reviewer tools appear only in their exact panels", (context) => {
  const state = fixture(context);
  const persisted = [];
  const logger = createRuntimeLogger({ logEvent: createAgentActivityLogger({ logEvent: (entry) => persisted.push(entry), executionActivity: state.activity }), output: { write() {} } });
  for (const agent of directory) state.activity({ agentId: agent.agent_id, correlationId: `CLAIM-${agent.agent_id}`, phase: "started" });
  const toolContext = { task_id: "TICKET-1", execution_id: "EXEC-CODER", agent_identity: { agent_id: "CODER-1" } };
  for (const status of ["started", "success", "failed"]) logger.emit(formatToolLogEvent(status, "read_file", { path: "private-source.js" }, toolContext, { error: { code: "READ_FAILED", details: { secret: "PRIVATE-CONTENT" } } }));
  logger.emit({ event_name: "sprint_leader.tool_call", status: "success", correlation_id: "PLAN-SL", payload: { agent_id: "SL-1", tool: "search_code", source: "PRIVATE-CONTENT" } });
  logger.emit({ event_name: "review.tool_call", status: "success", correlation_id: "REVIEW-1", payload: { agent_id: "REVIEWER-1", tool: "read_file", result: "PRIVATE-CONTENT" } });
  assert.equal(persisted.length, 5);
  const coder = codingAgentPanelActions(state.received, directory, projectId, "CODER-1");
  assert.deepEqual(coder.map((event) => event.payload.activity_type), ["started", "tool_started", "tool_completed", "tool_failed"]);
  assert(coder.every((event) => event.payload.correlation_id === "CLAIM-CODER-1"));
  for (const agentId of ["SL-1", "REVIEWER-1"]) {
    const actions = codingAgentPanelActions(state.received, directory, projectId, agentId);
    assert.equal(actions.at(-1).payload.activity_type, "tool_completed");
    assert(actions.every((event) => event.payload.agent_id === agentId));
  }
  assert.equal(JSON.stringify(state.received).includes("PRIVATE-CONTENT"), false);
  assert.equal(JSON.stringify(state.received).includes("private-source.js"), false);
});

// Prevents claim/request correlation differences from reopening panels closed by their owner.
test("tool activity preserves same-run close and ignores foreign or unattributed logs", (context) => {
  const state = fixture(context);
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
  state.close("CODER-1");
  const entry = { event_name: "forge.tool_success", status: "success", correlation_id: "REQUEST-1", payload: { agent_id: "CODER-1", tool: "read_file" } };
  state.activity.recordToolEvent(entry);
  assert.equal(state.registry.panels.length, 0);
  assert.equal(state.received.at(-1).payload.correlation_id, "CLAIM-1");
  const count = state.received.length;
  for (const invalid of [{ ...entry, project_id: "OTHER" }, { ...entry, payload: { tool: "read_file" } }, { ...entry, event_name: "unrelated.log" }]) state.activity.recordToolEvent(invalid);
  assert.equal(state.received.length, count);
});

// Keeps recent tool evidence available when a panel connects mid-run without replaying completed executions.
test("connecting mid-run replays bounded recent tool events as well as lifecycle", (context) => {
  const state = fixture(context, directory, (activity) => {
    activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
    for (let index = 0; index < 30; index++) activity.recordToolEvent({ event_name: "forge.tool_success", status: "success", payload: { agent_id: "CODER-1", tool: `read_${index}` } });
  });
  const actions = codingAgentPanelActions(state.received, directory, projectId, "CODER-1");
  assert.equal(actions.length, 21);
  assert.equal(actions[1].payload.tool_name, "read_10");
  assert.equal(actions.at(-1).payload.tool_name, "read_29");
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "completed" });
  assert.deepEqual(state.activity.snapshot(), []);
});

// Audited Codex Coder tool events stream into the active panel run, and SL/AM blocker triage opens lifecycle activity.
test("codex ticket tool events and blocker triage reach the activity stream", (context) => {
  const state = fixture(context, [...directory, { agent_id: "AM-1", role: "architecture_manager" }]);
  state.activity({ agentId: "CODER-1", correlationId: "CLAIM-1", phase: "started" });
  state.activity.recordToolEvent({ event_name: "supervisor.agent_tool_event", status: "success", correlation_id: "CORR-UI-RUN-1", payload: { agent_id: "CODER-1", tool: "commit_changes" } });
  state.activity.recordToolEvent({ event_name: "supervisor.agent_tool_event", status: "failed", correlation_id: "CORR-UI-RUN-1", payload: { agent_id: "CODER-1", tool: "run_test", error: "PRIVATE-CONTENT" } });
  state.activity.recordToolEvent({ event_name: "supervisor.blocker_triage_started", status: "started", task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-9-architecture_manager", payload: { agent_id: "AM-1", stage: "architecture_manager", job_id: "JOB-9" } });
  state.activity.recordToolEvent({ event_name: "supervisor.blocker_tool_call", status: "started", task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-9-architecture_manager", payload: { agent_id: "AM-1", role: "architecture_manager", tool: "read_file" } });
  state.activity.recordToolEvent({ event_name: "supervisor.blocker_tool_call", status: "success", task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-9-architecture_manager", payload: { agent_id: "AM-1", role: "architecture_manager", tool: "read_file" } });
  state.activity.recordToolEvent({ event_name: "supervisor.blocker_tool_call", status: "failed", task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-9-architecture_manager", payload: { agent_id: "AM-1", role: "architecture_manager", tool: "list_files", error_code: "BLOCKER_TOOL_FAILED" } });
  state.activity.recordToolEvent({ event_name: "supervisor.blocker_triage_finished", status: "success", task_id: "TICKET-1", correlation_id: "BLOCKER-JOB-9-architecture_manager", payload: { agent_id: "AM-1", stage: "architecture_manager", job_id: "JOB-9" } });
  const coder = codingAgentPanelActions(state.received, [...directory, { agent_id: "AM-1", role: "architecture_manager" }], projectId, "CODER-1");
  assert.deepEqual(coder.map((event) => event.payload.activity_type), ["started", "tool_completed", "tool_failed"]);
  assert(coder.every((event) => event.payload.correlation_id === "CLAIM-1"));
  const am = codingAgentPanelActions(state.received, [...directory, { agent_id: "AM-1", role: "architecture_manager" }], projectId, "AM-1");
  assert.deepEqual(am.map((event) => event.payload.activity_type), ["started", "tool_started", "tool_completed", "tool_failed", "completed"]);
  assert(am.every((event) => event.payload.correlation_id === "BLOCKER-JOB-9-architecture_manager"));
  assert.deepEqual(state.registry.panels.map((panel) => panel.agentId), ["CODER-1", "AM-1"]);
  assert.equal(JSON.stringify(state.received).includes("PRIVATE-CONTENT"), false);
});

test("report activity distinguishes pending verification from a failed check without exposing error contents", () => {
  const eventBus = new EventEmitter();
  const received = [];
  eventBus.on("agent.activity", (event) => received.push(event.payload));
  const activity = createAgentExecutionActivity({ projectId, eventBus });
  const entry = { event_name: "supervisor.agent_tool_event", status: "failed", correlation_id: "RUN-REPORT",
    payload: { agent_id: "CODER-1", tool: "report_done", error: { code: "VERIFY_RECOVERY_PENDING", message: "PRIVATE-CONTENT" } } };
  activity.recordToolEvent(entry);
  assert.equal(received.at(-1).status, "working");
  assert.match(received.at(-1).summary, /wait for Node/);
  activity.recordToolEvent({ ...entry, payload: { ...entry.payload, error: { code: "CODER_EVIDENCE_PENDING", message: "PRIVATE-CONTENT" } } });
  assert.equal(received.at(-1).status, "failed");
  assert.match(received.at(-1).summary, /CODER_EVIDENCE_PENDING/);
  activity.recordToolEvent({ ...entry, error_code: "PRIVATE-CONTENT\nINVALID" });
  assert.equal(received.at(-1).summary, "Agent tool report_done failed.");
  assert(!JSON.stringify(received).includes("PRIVATE-CONTENT"));
});


// Node wait transitions remain working activity; only the real tool result completes or fails the operation.
test("Node verification wait and terminal notices reach the agent panel without source output", () => {
  const eventBus = new EventEmitter();
  const received = [];
  eventBus.on("agent.activity", (event) => received.push(event.payload));
  const activity = createAgentExecutionActivity({ projectId, eventBus });
  for (const event_name of ["ticket.verification_waiting", "ticket.verification_wait_finished"]) {
    activity.recordToolEvent({ event_name, status: "pending", correlation_id: "WAIT", message: "Node verification progress",
      payload: { agent_id: "CODER-1", job_id: "VERIFY-1", diagnostic: "PRIVATE-CONTENT" } });
  }
  assert.equal(received.length, 2);
  assert(received.every((event) => event.status === "working" && event.tool_name === "report_done"));
  assert(!JSON.stringify(received).includes("PRIVATE-CONTENT"));
});

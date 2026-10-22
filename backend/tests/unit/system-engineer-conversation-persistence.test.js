// Verifies command-only SE SDK events survive live project SSE and disk-backed conversation reload.
import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentCommunicationStore } from "../../src/modules/governance/agent-communication-store.js";
import { createAgentCommunicationBus } from "../../src/modules/governance/agent-communication-bus.js";
import { createUnifiedStreamPublisher } from "../../scripts/control-api-unified-stream.mjs";
import { createUnifiedStreamOrderer } from "../../src/modules/events/unified-stream-order.js";
import { createProjectStream } from "../../src/transport/sse/project-stream.js";
import { createConversationAuditHistoryService } from "../../src/application/conversation-audit-history-service.js";
import { withSystemEngineerEvents } from "../../src/application/system-engineer-sdk-events.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";

// Checks production SSE, storage, history pagination and schema even on a non-SQLite runner.
// Disk-backed restart coverage below remains enabled on the project's supported Node runtime.
test("SE commands are stored before live delivery, paginated and schema-valid", async () => {
  const communications = createAgentCommunicationStore();
  const bus = createAgentCommunicationBus({ store: communications });
  const internalBus = new EventEmitter();
  const frames = [];
  const stream = createProjectStream({ projectId: "PROJECT-SE", indexDb: { all: () => [] }, eventBus: internalBus, bus,
    subscriptions: { subscribe() { return "SUB"; }, unsubscribe() {} } });
  const connection = stream.connect({ requestedProjectId: "PROJECT-SE", response: { write: (frame) => frames.push(frame), writeHead() {}, end() {} } });
  internalBus.on("agent.activity", () => assert.ok(communications.getAll().length > 0));
  try {
    const publish = createUnifiedStreamPublisher({ projectId: "PROJECT-SE", internalBus, bus, unifiedStreamOrder: createUnifiedStreamOrderer(), logEvent: (error) => assert.fail(JSON.stringify(error)) });
    const source = { type: "item.completed", item: { type: "command_execution", command: "git diff --check", aggregated_output: `${"output\n".repeat(2000)}END`, exit_code: 0 }, usage: { input_tokens: 42, output_tokens: 100 } };
    const sdk = withSystemEngineerEvents({ execute: async (request) => { await request.onEvent({ ...source, type: "item.started" }); await request.onEvent(source); } },
      { profile: { role: "system_engineer", agent_id: "SE", provider: "codex" }, conversationId: "CHAT", correlationId: "RUN", eventSink: publish });
    await sdk.execute({});
    const live = frames.filter((frame) => frame.startsWith("id:")).map((frame) => JSON.parse(frame.split("data: ")[1])).filter((event) => event.payload.sdk_event);
    assert.equal(live.length, 3);
    const require = createRequire(import.meta.url);
    const ajv = addFormats(new Ajv2020({ strict: false }));
    ajv.addSchema(require("../../../schemas/stream/architecture-clarification-waiting.schema.json"));
    const validate = ajv.compile(require("../../../schemas/stream/project-stream-event.schema.json"));
    for (const event of live) assert.ok(validate(event), JSON.stringify(validate.errors));
    assert.equal(validate({ ...live[0], payload: { ...live[0].payload, agent_role: "coder" } }), false);
    const history = createConversationAuditHistoryService({ communications });
    const first = history.query({ projectId: "PROJECT-SE", conversationId: "CHAT", agentId: "SE", chatOnly: true, order: "desc", limit: 1 });
    assert.equal(first.items[0].content.sdk_event.entries[0].command, "git diff --check");
    assert.equal(first.items[0].content.activity_id, live.at(-1).payload.activity_id);
    assert.equal(communications.getAll().length, 1);
    assert.equal(first.next_cursor, null);
    assert.equal(history.query({ projectId: "OTHER", conversationId: "CHAT", chatOnly: true }).items.length, 0);
  } finally { connection.close(); }
});

// A failed SE event write must be reported instead of displaying an event that cannot replay.
test("SE storage failure is logged and propagated before publishing the raw event", () => {
  const internalBus = new EventEmitter();
  let emitted = false;
  internalBus.on("event", () => { emitted = true; });
  const logs = [];
  const error = new Error("storage unavailable");
  const publish = createUnifiedStreamPublisher({ projectId: "PROJECT-SE", internalBus, bus: { send() { throw error; } }, unifiedStreamOrder: createUnifiedStreamOrderer(), logEvent: (entry) => logs.push(entry) });
  assert.throws(() => publish({ event_type: "agent.activity", payload: { agent_role: "system_engineer", conversation_id: "CHAT", sdk_event: { type: "error" } } }), error);
  assert.equal(emitted, false);
  assert.equal(logs[0].error_code, "STREAM_DELIVERY_FAILED");
});

// Uses real message validation, JSONL source storage and SQLite indexes, not a memory-only mock.
test("SE commands reach SSE and conversation pages without output after a database restart", { skip: Number(process.versions.node.split(".")[0]) < 22 ? "Disk-backed SQLite verification requires the project's Node >=22.5 runtime." : false }, async () => {
  const { createDatabaseService } = await import("../../src/infrastructure/sqlite/database-service.js");
  const root = await mkdtemp(join(process.cwd(), "se-events-test-"));
  let database;
  let connection;
  try {
    database = await createDatabaseService({ dataDir: root, runtimeDir: ".forge/runtime/nf" });
    const files = createFileService({ projectRoot: root });
    const communications = createAgentCommunicationStore({ database, fileService: files });
    const bus = createAgentCommunicationBus({ store: communications });
    const internalBus = new EventEmitter();
    const frames = [];
    const stream = createProjectStream({ projectId: "PROJECT-SE", indexDb: { all: () => [] }, eventBus: internalBus, bus,
      subscriptions: { subscribe() { return "SUB"; }, unsubscribe() {} } });
    connection = stream.connect({ requestedProjectId: "PROJECT-SE", response: { write: (frame) => frames.push(frame), writeHead() {}, end() {} } });
    const publish = createUnifiedStreamPublisher({ projectId: "PROJECT-SE", internalBus, bus, unifiedStreamOrder: createUnifiedStreamOrderer(), logEvent: (error) => assert.fail(JSON.stringify(error)) });
    const output = `${"完整输出\n".repeat(10000)}OUTPUT-END`;
    const source = { type: "item.completed", item: { type: "command_execution", id: "COMMAND", command: `printf ${"long-argument".repeat(100)}`, aggregated_output: output, exit_code: 1 } };
    const sdk = withSystemEngineerEvents({ execute: async (request) => request.onEvent(source) },
      { profile: { role: "system_engineer", agent_id: "SE", provider: "codex" }, conversationId: "CHAT", correlationId: "RUN", eventSink: publish });
    await sdk.execute({});
    const live = frames.filter((frame) => frame.startsWith("id:")).map((frame) => JSON.parse(frame.split("data: ")[1])).filter((event) => event.payload.sdk_event);
    assert.equal(live.length, 2);
    assert.equal(live.at(-1).payload.sdk_event.entries[0].command, source.item.command);
    assert.equal(live.at(-1).payload.sdk_event.entries[0].status, "failed");
    const savedId = live.at(-1).payload.activity_id;
    await database.close();
    database = await createDatabaseService({ dataDir: root, runtimeDir: ".forge/runtime/nf" });
    const reloaded = createAgentCommunicationStore({ database, fileService: files });
    const history = createConversationAuditHistoryService({ communications: reloaded });
    const routes = createForgeV1ConversationRoutes({ conversationCrudService: { get: () => ({ project_id: "PROJECT-SE" }) }, conversationAuditHistoryService: history });
    const result = await routes.routeConversation({ method: "GET", parts: ["conversations", "CHAT", "messages"], url: new URL("http://localhost/forge/v1/conversations/CHAT/messages?limit=1&order=desc"), projectId: "PROJECT-SE" });
    assert.equal(result.body.items.length, 1);
    assert.equal(result.body.items[0].content.sdk_event.entries[0].command, source.item.command);
    assert.equal(result.body.items[0].content.activity_id, savedId);
    assert.equal(history.query({ projectId: "PROJECT-SE", conversationId: "CHAT", agentId: "SE", chatOnly: true }).items.length, 1);
    assert.equal(history.query({ projectId: "PROJECT-SE", conversationId: "OTHER", chatOnly: true }).items.length, 0);
    assert.equal(history.query({ projectId: "OTHER-PROJECT", conversationId: "CHAT", chatOnly: true }).items.length, 0);
  } finally {
    connection?.close();
    await database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

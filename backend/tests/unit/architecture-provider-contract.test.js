// Verifies Architecture discovery and generation reach provider SDKs with distinct execution identity and read-only contracts.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { createOwnerChatService } from "../../src/application/owner-chat-service.js";
import { createOwnerSdkStream } from "../../src/application/owner-sdk-stream.js";
import { createForgeV1ConversationRoutes } from "../../src/transport/http/forge-v1-conversation-routes.js";
import { clarificationFixture } from "./architecture-clarification-fixture.js";

test("two-phase plan command uses read-only provider tools, JSON discovery and distinct execution IDs", async (context) => {
  const fixture = await clarificationFixture(context, []); const calls = [];
  const sdk = { conversationMode: "history", execute: async (input) => { calls.push(input); return { text: await fixture.provider(input.prompt.includes("Architecture clarification discovery") ? "Architecture clarification discovery" : "Generate plan") }; } };
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "architecture-manager", role: "architecture_manager", provider: "openai" }) }, sdkGateways: { openai: sdk }, fallbackStream: async function* () {}, architectureCheckpoint: { start: () => assert.fail("Read-only planning recovery belongs to the clarification store, not document-mutation checkpoints") }, fileService: fixture.fileService, projectRoot: fixture.root, projectLogger: () => {} });
  const service = createOwnerChatService({ bus: { send() {}, sendFast() {} }, commandService: fixture.command, agentStream: stream });
  const result = await service.submit({ project_id: "PROJECT-A", conversation_id: "CONV-A", agent_id: "architecture-manager", message_id: "MSG-PLAN", correlation_id: "CORR-PLAN", timestamp: new Date().toISOString(), payload: { text: "/plan workflows/input.md" } });
  assert.equal(result.payload.status, "awaiting_human_approval"); assert.equal(calls.length, 2);
  assert.notEqual(calls[0].options.forgeTools.context.execution_id, calls[1].options.forgeTools.context.execution_id);
  for (const call of calls) {
    assert.deepEqual(call.options.forgeTools.definitions.map((tool) => tool.name), ["search_tree", "list_files", "search_text", "read_file", "read_lines"]);
    assert.match(call.prompt, /structured JSON for clarification discovery/);
  }
  assert.doesNotMatch(calls[0].prompt, /The owner explicitly selected Markdown/);
  assert.match(calls[1].prompt, /The owner explicitly selected Markdown/);
  assert.equal(fixture.records.length, 1);
});

test("conversation route discards injected owner identity and uses authenticated confirmation identity", async () => {
  const submissions = [];
  const { routeConversation: route } = createForgeV1ConversationRoutes({ conversationCrudService: { get: () => ({ project_id: "PROJECT-A", agent_id: "architecture-manager", status: "active" }) }, ownerChatService: { submit: async (input) => { submissions.push(input); return input; } }, planOwnerAuth: { verify: () => "AUTHENTICATED" } });
  const input = { method: "POST", parts: ["conversations", "CONV-A", "messages"], projectId: "PROJECT-A", headers: {}, body: { approved_owner_id: "FORGED", payload: { text: "/plan-continue CLARIFY-00000000-0000-0000-0000-000000000000" } } };
  await route(input); assert.equal(submissions[0].approved_owner_id, "AUTHENTICATED");
  await route({ ...input, body: { ...input.body, payload: { text: "/plan workflows/input.md" } } });
  assert.equal(submissions[1].approved_owner_id, undefined);
});

test("ordinary Architecture document editing still requires its execution checkpoint", async (context) => {
  const fixture = await clarificationFixture(context); let claimed = false;
  const stream = createOwnerSdkStream({ agentConfiguration: { getById: () => ({ agent_id: "architecture-manager", role: "architecture_manager", provider: "openai" }) }, sdkGateways: { openai: { conversationMode: "history", execute: () => assert.fail("Checkpoint must authorize editing before provider runs") } }, fallbackStream: async function* () {}, architectureCheckpoint: { role: "architecture_manager", start: () => { claimed = true; throw Object.assign(new Error("Reconcile existing edit first"), { code: "EXECUTION_DECISION_REQUIRED" }); } }, fileService: fixture.fileService, projectRoot: fixture.root, projectLogger: () => {} });
  await assert.rejects(async () => { for await (const chunk of stream({ agentId: "architecture-manager", payload: { text: "Edit architecture document" }, correlationId: "CORR-EDIT", conversationId: "CONV-A" })) assert.fail(chunk.text); }, { code: "EXECUTION_DECISION_REQUIRED" });
  assert.equal(claimed, true);
});

test("waiting event schema accepts clarification identity and rejects missing identity or approval claims", async () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true }); addFormats(ajv);
  const waiting = JSON.parse(await readFile("schemas/stream/architecture-clarification-waiting.schema.json", "utf8"));
  const stream = JSON.parse(await readFile("schemas/stream/project-stream-event.schema.json", "utf8"));
  ajv.addSchema(waiting); const validate = ajv.compile(stream);
  const event = { event_id: "EVENT-A", event_type: "plan.request.awaiting_owner_decisions", schema_version: 1, project_id: "PROJECT-A", timestamp: new Date().toISOString(), payload: { request_id: "PLAN-REQUEST-A", session_id: "CLARIFY-00000000-0000-0000-0000-000000000000" } };
  assert.equal(validate(event), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...event, payload: { request_id: "PLAN-REQUEST-A" } }), false);
  assert.equal(validate({ ...event, payload: { ...event.payload, approved: true } }), false);
});

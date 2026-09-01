import assert from "node:assert/strict";
import test from "node:test";
import { createStage1RequestSender } from "../../src/modules/workflows/stage1-request-sender.js";

const envelope = { request_id: "11111111-1111-4111-8111-111111111111", parent_id: null, type: "task", role: "node", payload: { task_id: "FORGE-STAGE1-001", step_id: 1, metadata: { correlation_id: "CORR-STAGE1" } } };
const response = { request_id: "22222222-2222-4222-8222-222222222222", parent_id: envelope.request_id, type: "code_needed", role: "agent", payload: { files_requested: ["src/a.js"], reason: "inspect" }, timestamp: "2026-08-31T00:00:00.000Z" };

function logger(events) { return { requestSent: (entry) => events.push({ event: "sent", ...entry }), failed: (entry) => events.push({ event: "failed", ...entry }) }; }

test("sends through profile-selected OpenAI adapter and persists request/response", async () => {
  const events = []; const saved = [];
  const sender = createStage1RequestSender({ adapterResolver: (provider) => { assert.equal(provider, "openai"); return { call: async (args) => { assert.equal(args.payload.request_id, envelope.request_id); assert.equal(args.payload.expected_output.type, "code_needed"); return response; } }; }, protocolLogger: logger(events), protocolStorage: { save: async (ref, data) => saved.push({ ref, data }) } });
  const result = await sender.sendRequest(envelope, { agentProfile: { provider: "openai", gateway_url: "https://gateway.test", model: "gpt-5.6" }, credential: "secret" });
  assert.equal(result.response.type, "code_needed"); assert.deepEqual(saved.map(({ ref }) => ref), ["task/FORGE-STAGE1-001/round_1/request", "task/FORGE-STAGE1-001/round_1/response"]); assert.equal(events[0].event, "sent");
});

test("logs failure and does not hide adapter errors", async () => {
  const events = []; const sender = createStage1RequestSender({ adapterResolver: () => ({ call: async () => { throw new Error("gateway down"); } }), protocolLogger: logger(events) });
  await assert.rejects(() => sender.sendRequest(envelope, { agentProfile: { provider: "openai" } }), /gateway down/); assert.equal(events.at(-1).event, "failed");
});

test("sends round-2 code_provide content to OpenAI and stores round 2 refs", async () => {
  const events = []; const saved = []; let providerPayload;
  const round2 = { request_id: "33333333-3333-4333-8333-333333333333", parent_id: response.request_id, type: "code_provide", role: "node", payload: { task_id: envelope.payload.task_id, step_id: 2, files: [{ path: "src/a.js", exists: true, content: "export const a = 1;" }] } };
  const sender = createStage1RequestSender({ adapterResolver: () => ({ call: async ({ payload }) => { providerPayload = payload; return { type: "submit_code_response", payload: {}, request_id: "44444444-4444-4444-8444-444444444444", parent_id: round2.request_id, role: "agent", timestamp: "2026-08-31T00:00:00.000Z" }; } }), protocolLogger: logger(events), protocolStorage: { save: async (ref, data) => saved.push({ ref, data }) } });
  await sender.sendRequest(round2, { agentProfile: { provider: "openai" } });
  assert.equal(providerPayload.request_id, round2.request_id); assert.equal(providerPayload.expected_output.type, "submit_code_response"); assert.match(providerPayload.user_blocks[0].content, /export const a/); assert.deepEqual(saved.map(({ ref }) => ref), ["task/FORGE-STAGE1-001/round_2/request", "task/FORGE-STAGE1-001/round_2/response"]);
});

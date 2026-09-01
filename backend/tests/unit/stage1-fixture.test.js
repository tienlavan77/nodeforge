import assert from "node:assert/strict";
import test from "node:test";
import { createStage1MockAgent, stage1AgentProfile, stage1Target, stage1Ticket } from "../fixtures/stage1-openai-fixture.js";

test("stage-1 fixture supplies a valid minimal ticket and OpenAI profile", () => {
  assert.equal(stage1Ticket.id, "FORGE-STAGE1-001");
  assert.equal(stage1Ticket.dependencies.length, 0);
  assert.ok(stage1Ticket.acceptance_criteria.length > 0);
  assert.equal(stage1AgentProfile.provider, "openai");
  assert.equal(stage1AgentProfile.agent_id, "builder");
  assert.match(stage1AgentProfile.gateway_url, /^https:\/\//);
  assert.match(stage1AgentProfile.credential_ref, /^runtime:/);
  assert.equal(stage1Target.path, "tests/fixtures/stage1-marker.txt");
});

test("stage-1 mock returns code_needed then submit_code_response and exposes requests", async () => {
  const agent = createStage1MockAgent();
  const first = await agent.respond({ request_id: "11111111-1111-4111-8111-111111111111", type: "task", role: "node" });
  const second = await agent.respond({ request_id: "22222222-2222-4222-8222-222222222222", type: "code_provide", role: "node" });
  assert.equal(first.type, "code_needed");
  assert.equal(second.type, "submit_code_response");
  assert.equal(second.payload.files[0].format, "full_content");
  assert.equal(agent.requests.length, 2);
  assert.equal(agent.requests[1].type, "code_provide");
});

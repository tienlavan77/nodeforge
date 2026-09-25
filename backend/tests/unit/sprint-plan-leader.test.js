import assert from "node:assert/strict";
import test from "node:test";

import { createSprintPlanLeader } from "../../src/application/sprint-plan-leader.js";

// Covers the SDK plan runner: built-in search tools only, no Forge MCP, and
// the final plan JSON parsed from SDK message text.
test("runner executes with built-in search tools and no Forge MCP", async () => {
  const calls = [];
  const sdkGateway = {
    execute: async (args) => {
      calls.push(args);
      return { messages: [{ text: '```json\n{"id":"SPRINT-1","roadmap_id":"ROADMAP-1","project_id":"P1","objective":"Ship it","tickets":[{"title":"T","objective":"O","acceptance_criteria":["A"],"style":["backend"],"candidate_files":[{"path":"backend/a.js","role":"PATCH","symbol":"handleRequest","reason":"edit handleRequest"}]}],"exit_criteria":["Done"]}\n```' }] };
    }
  };
  const leader = createSprintPlanLeader({ sdkGateway, projectRoot: "/repo" });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "AGENT-SL", brief: "sprint brief", correlationId: "CORR-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.deepEqual(calls[0].options.allowedTools, ["Read", "Grep", "Glob"]);
  assert.equal(calls[0].options.mcpServers, undefined);
  assert.match(calls[0].prompt, /built-in tools only/);
  assert.match(calls[0].prompt, /Do NOT use any Forge MCP tools/);
  assert.equal(plan.id, "SPRINT-1");
  assert.equal(plan.tickets[0].candidate_files[0].path, "backend/a.js");
});

test("runner throws without an SDK gateway", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: null });
  await assert.rejects(() => leader.requestPlan({ projectId: "P1", agentId: "A", brief: "b", correlationId: "C" }), /requires an SDK gateway/);
});

// Keeps Codex sprint plans available when the SDK returns text instead of messages.
test("runner parses a Codex SDK sprint plan from text", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async () => ({ text: '```json\n{"id":"SPRINT-1","objective":"Ship it"}\n```', items: [] }) } });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "AGENT-SL", brief: "ship it", correlationId: "CORR-1" });
  assert.equal(plan.id, "SPRINT-1");
});

test("runner returns undefined when SDK messages hold no plan JSON", async () => {
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async () => ({ messages: [{ text: "no json here" }] }) } });
  const plan = await leader.requestPlan({ projectId: "P1", agentId: "A", brief: "b", correlationId: "C" });
  assert.equal(plan, undefined);
});

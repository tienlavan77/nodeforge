import assert from "node:assert/strict";
import test from "node:test";

import { createTicketSprintLeader } from "../../src/application/ticket-sprint-leader.js";

// Covers the SDK sprint-leader runner: built-in search tools only, no Forge
// MCP, and the final ticket JSON parsed from SDK message text.
test("runner executes with built-in search tools and no Forge MCP", async () => {
  const calls = [];
  const sdkGateway = {
    execute: async (args) => {
      calls.push(args);
      return { messages: [{ text: '```json\n{"title":"T","objective":"O","acceptance_criteria":["A"],"style":["backend"],"candidate_files":[{"path":"backend/a.js","role":"PATCH","symbol":"handleRequest","reason":"edit handleRequest"}]}\n```' }] };
    }
  };
  const leader = createTicketSprintLeader({ sdkGateway, projectRoot: "/repo" });
  const draft = await leader.requestTicket({ projectId: "P1", agentId: "AGENT-SL", content: "fix api", feedback: undefined, correlationId: "CORR-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.deepEqual(calls[0].options.allowedTools, ["Read", "Grep", "Glob"]);
  assert.equal(calls[0].options.mcpServers, undefined);
  assert.match(calls[0].prompt, /built-in tools only/);
  assert.match(calls[0].prompt, /Do NOT use any Forge MCP tools/);
  assert.equal(draft.title, "T");
  assert.equal(draft.candidate_files[0].path, "backend/a.js");
});

test("runner throws without an SDK gateway", async () => {
  const leader = createTicketSprintLeader({ sdkGateway: null });
  await assert.rejects(() => leader.requestTicket({ projectId: "P1", agentId: "A", content: "x", correlationId: "C" }), /requires an SDK gateway/);
});

test("runner returns undefined when SDK messages hold no ticket JSON", async () => {
  const leader = createTicketSprintLeader({ sdkGateway: { execute: async () => ({ messages: [{ text: "no json here" }] }) } });
  const draft = await leader.requestTicket({ projectId: "P1", agentId: "A", content: "x", correlationId: "C" });
  assert.equal(draft, undefined);
});

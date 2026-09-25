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

// Keeps Codex ticket drafts available for regeneration when the SDK returns text instead of messages.
test("runner parses a Codex SDK ticket from text", async () => {
  const leader = createTicketSprintLeader({ sdkGateway: { execute: async () => ({ text: '```json\n{"title":"T","objective":"O","acceptance_criteria":["A"]}\n```', items: [] }) } });
  const draft = await leader.requestTicket({ projectId: "P1", agentId: "AGENT-SL", content: "fix api", correlationId: "CORR-1" });
  assert.equal(draft.title, "T");
});

test("runner logs safe parse diagnostics when SDK output has no ticket JSON", async () => {
  const events = [];
  const ownerContext = "Vietnamese owner context with credential=owner-secret";
  let callCount = 0;
  let request;
  const leader = createTicketSprintLeader({
    sdkGateway: { execute: async (args) => { request = args; callCount += 1; return { messages: [{ text: `short output token=agent-secret ${ownerContext}` }, { text: "still not JSON" }] }; } },
    logger: { error: (message, details) => events.push({ message, details }) }
  });

  const draft = await leader.requestTicket({ projectId: "P1", agentId: "AGENT-SL", content: ownerContext, correlationId: "CORR-1" });

  assert.equal(draft, undefined);
  assert.equal(callCount, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].message, "SPRINT_LEADER_TICKET_PARSE_FAILED");
  assert.deepEqual(events[0].details, {
    agent_id: "AGENT-SL",
    correlation_id: "CORR-1",
    task_id: "PROJECT-P1",
    prompt_chars: request.prompt.length,
    response_fields: ["messages"],
    result_text_chars: null,
    message_count: 2,
    output_chars: (`short output token=agent-secret ${ownerContext}\nstill not JSON`).length,
    message_summary: [
      { type: "unknown", content_types: [], text_lengths: [] },
      { type: "unknown", content_types: [], text_lengths: [] }
    ],
    output_preview: "short output [REDACTED] [OWNER_CONTEXT]\nstill not JSON"
  });
  assert.ok(events[0].details.output_preview.length <= 500);
  assert.doesNotMatch(events[0].details.output_preview, /owner-secret|agent-secret/);
});

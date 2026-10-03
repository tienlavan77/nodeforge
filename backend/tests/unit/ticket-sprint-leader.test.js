import assert from "node:assert/strict";
import test from "node:test";

import { createTicketSprintLeader } from "../../src/application/ticket-sprint-leader.js";

// Covers ticket drafting with read-only Forge tools and without candidate requirements.
test("runner drafts a ticket without source-file candidates", async () => {
  const calls = [];
  const sdkGateway = {
    execute: async (args) => {
      calls.push(args);
      return { messages: [{ text: '```json\n{"title":"T","objective":"O","acceptance_criteria":["A"],"implementation_type":["backend"]}\n```' }] };
    }
  };
  const leader = createTicketSprintLeader({ sdkGateway, projectRoot: "/repo", toolOptions: () => ({ forgeTools: { definitions: [{ name: "search_tree" }] } }) });
  const draft = await leader.requestTicket({ projectId: "P1", agentId: "AGENT-SL", content: "fix api", feedback: undefined, correlationId: "CORR-1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cwd, "/repo");
  assert.deepEqual(calls[0].options.forgeTools.definitions.map(({ name }) => name), ["search_tree"]);
  assert.match(calls[0].prompt, /Do not identify source files or symbols/);
  assert.match(calls[0].prompt, /implementation_type/);
  assert.deepEqual(draft.implementation_type, ["backend"]);
  assert.equal(draft.title, "T");
  assert.equal(draft.candidate_files, undefined);
});

test("runner throws without an SDK gateway", async () => {
  const leader = createTicketSprintLeader({ sdkGateway: null });
  await assert.rejects(() => leader.requestTicket({ projectId: "P1", agentId: "A", content: "x", correlationId: "C" }), /requires an SDK gateway/);
});

// Keeps Codex ticket drafts available for regeneration when the SDK returns text instead of messages.
test("runner parses a Codex SDK ticket from text", async () => {
  const leader = createTicketSprintLeader({ sdkGateway: { execute: async () => ({ text: '```json\n{"title":"T","objective":"O","acceptance_criteria":["A"]}\n```', items: [] }) }, toolOptions: () => ({ tools: [] }) });
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
    toolOptions: () => ({ tools: [] }),
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

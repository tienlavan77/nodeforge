import assert from "node:assert/strict";
import test from "node:test";
import { normalizeTicketInput, detectMessageIntent } from "../../web/src/services/node-client.js";

test("normalizes plain and Markdown ticket labels", () => {
  const result = normalizeTicketInput("Ticket:\n- **Title:** Demo\n- **Objective:** Run\n- **Acceptance Criteria:** Works");
  assert.equal(result.recognized, true);
  assert.deepEqual(result.missing, []);
  assert.match(result.text, /title: Demo/);
  assert.match(result.text, /acceptance_criteria: Works/);
});

test("blocks recognized tickets missing required fields", () => {
  const result = normalizeTicketInput("Ticket:\nTitle: Demo");
  assert.deepEqual(result.missing, ["objective", "acceptance_criteria"]);
});

test("does not block technical JSON or ordinary chat", () => {
  assert.equal(normalizeTicketInput("Debug payload: {}" ).recognized, false);
  assert.equal(normalizeTicketInput("[1, 2, 3]").recognized, false);
  assert.equal(normalizeTicketInput("Can you inspect this JSON?").recognized, false);
});

test("preserves valid ticket JSON", () => {
  const result = normalizeTicketInput(JSON.stringify({ id: "T-1", title: "Demo", objective: "Run", acceptance_criteria: ["Works"] }));
  assert.equal(result.recognized, true);
  assert.deepEqual(result.missing, []);
});

test("extracts embedded ticket JSON and preserves incomplete tickets for backend validation", () => {
  const value = { id: "T-2", title: "Incomplete" };
  const result = normalizeTicketInput(`Prefix\n${JSON.stringify(value)}\nSuffix`);
  assert.equal(result.recognized, true);
  assert.deepEqual(result.missing, ["objective", "acceptance_criteria"]);
  assert.equal(result.text.includes(JSON.stringify(value)), true);
  assert.deepEqual(result.ticket, value);
});

test("detects explicit message intents", () => {
  assert.equal(detectMessageIntent("/ticket NF-1"), "ticket_dispatch");
  assert.equal(detectMessageIntent("Title: Demo\nObjective: Run\nAcceptance Criteria: Works"), "ticket_create");
  assert.equal(detectMessageIntent("hello {\"debug\":true}"), "normal_chat");
});

test("keeps an explicitly normal chat payload verbatim", async () => {
  const { createNodeClient } = await import("../../web/src/services/node-client.js");
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response("{}", { status: 202, headers: { "content-type": "application/json" } }); };
  try {
    const text = 'Please discuss this example: {"title":"Demo","objective":"Explain","acceptance_criteria":["Clear"]}';
    await createNodeClient().postOwnerMessage({ projectId: "P", conversationId: "C", agentId: "builder", messageId: "M", correlationId: "R", text, intent: "normal_chat" });
    assert.equal(body.payload.intent, "normal_chat");
    assert.equal(body.payload.text, text);
  } finally { globalThis.fetch = originalFetch; }
});

test("routes malformed JSON with a newline in a quoted value as normal chat", async () => {
  const { createNodeClient } = await import("../../web/src/services/node-client.js");
  const originalFetch = globalThis.fetch;
  let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response("{}", { status: 202, headers: { "content-type": "application/json" } }); };
  try {
    const text = 'Ticket JSON:\n{"title":"Demo","objective":"line one\nline two","acceptance_criteria":["Works"]}';
    await createNodeClient().postOwnerMessage({ projectId: "P", conversationId: "C", agentId: "builder", messageId: "M-NEWLINE", correlationId: "R-NEWLINE", text });
    assert.equal(body.payload.intent, "ticket_create");
    assert.equal(body.payload.ticket.objective, "line one line two");
  } finally { globalThis.fetch = originalFetch; }
});

test("sends raw and normalized text separately for ticket creation", async () => {
  const { createNodeClient } = await import("../../web/src/services/node-client.js");
  const originalFetch = globalThis.fetch; let body;
  globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return new Response("{}", { status: 202, headers: { "content-type": "application/json" } }); };
  try {
    const text = 'Prefix\n{"id":"T-RAW","title":"Demo","objective":"line one","acceptance_criteria":["Works"]}\nSuffix';
    await createNodeClient().postOwnerMessage({ projectId: "P", conversationId: "C", agentId: "builder", messageId: "M-RAW", correlationId: "R-RAW", text });
    assert.equal(body.payload.raw_text, text);
    assert.equal(body.payload.text, text);
    assert.equal(body.payload.ticket.id, "T-RAW");
    assert.equal(body.payload.normalized_text.includes("Prefix {"), true);
  } finally { globalThis.fetch = originalFetch; }
});

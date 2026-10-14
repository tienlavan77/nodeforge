// Verifies completed owner commands reveal durable Architecture choices without a reload or a functioning SSE notification.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createHomeMessageHandlers } from "../lib/home-page-message-handlers.js";
import { createCodingPlanEvents } from "../lib/coding-plan-events.js";
import { createArchitectureClarificationLoader, refreshArchitectureClarifications } from "../lib/architecture-clarification-loader.js";

for (const action of ["send", "edit", "retry"]) {
  test(`${action}: HTTP planning result triggers current-conversation reconciliation without SSE`, async (context) => {
    const conversationId = "123e4567-e89b-42d3-a456-426614174000";
    let sessions = [];
    const states = []; const loads = [];
    const events = createCodingPlanEvents("PROJECT-A");
    const client = { listArchitectureClarifications: async () => sessions, postOwnerMessage: async () => {
      sessions = [{ session_id: "CLARIFY-A", status: "awaiting_owner_decisions" }];
      return { project_id: "PROJECT-A", conversation_id: conversationId, message_type: "owner.command.result", payload: { status: "awaiting_owner_decisions" } };
    } };
    const loader = createArchitectureClarificationLoader({ client, projectId: "PROJECT-A", conversationId, onState: (state) => states.push(state) });
    context.after(events.subscribe((event) => { if (refreshArchitectureClarifications(event, "PROJECT-A", conversationId)) loads.push(loader.load()); }));
    await loader.load();
    assert.equal(states[0].sessions.length, 0);
    const handlers = createHomeMessageHandlers({ client, projectId: "PROJECT-A", activeConversationId: conversationId, selectedArchitectureManager: { id: "architecture-manager" }, setChatState() {}, setMessages() {}, setAgentTyping() {}, sendingRef: { current: false }, lastSentRef: { current: null }, onCommandResult: events.publishCommandResult });
    if (action === "send") await handlers.sendMessage("/plan workflows/input.md");
    if (action === "edit") await handlers.editMessage({ id: "MSG-A", text: "old input" }, "/plan workflows/input.md");
    if (action === "retry") await handlers.retryMessage({ text: "/plan workflows/input.md" });
    await Promise.all(loads);
    assert.equal(loads.length, 1);
    assert.equal(states.at(-1).sessions[0].status, "awaiting_owner_decisions");
  });
}

test("HTTP results preserve project and conversation isolation and ignore ordinary chat acknowledgments", () => {
  const events = createCodingPlanEvents("PROJECT-A"); const refreshes = [];
  const result = { project_id: "PROJECT-A", conversation_id: "CONV-A", message_type: "owner.command.result" };
  events.subscribe((event) => { if (refreshArchitectureClarifications(event, "PROJECT-A", "CONV-A")) refreshes.push(event); });
  for (const input of [null, {}, { ...result, project_id: "PROJECT-B" }, { ...result, conversation_id: "CONV-B" }, { ...result, message_type: "owner.message" }]) events.publishCommandResult(input);
  assert.equal(refreshes.length, 0);
  events.publishCommandResult({ ...result, message_type: "owner.command.error" });
  assert.equal(refreshes.length, 1);
});

test("home conversation forwards HTTP command completions to the mounted Architecture wizard", async () => {
  const page = await readFile("ui/nextjs/app/page.jsx", "utf8");
  assert.match(page, /onCommandResult:\s*\(result\)\s*=>\s*\{\s*planEvents\.publishCommandResult\(result\)/);
  assert.match(page, /onPlanCreated=\{\(result\) => loadConversationMessages\(result\.conversation_id, \{ preserve: true \}\)\}/);
  assert.match(page, /<ArchitectureClarifications[^>]*planEvents=\{planEvents\}/);
});

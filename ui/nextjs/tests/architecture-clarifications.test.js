// Verifies source-bound clarification transport and event-driven reloads without polling or stale response overwrites.
import assert from "node:assert/strict";
import test from "node:test";
import { createArchitectureClarificationClient } from "../lib/architecture-clarification-client.js";
import { createArchitectureClarificationLoader, refreshArchitectureClarifications } from "../lib/architecture-clarification-loader.js";

test("clarification loader ignores obsolete responses and preserves saved answers on refresh error", async () => {
  const requests = []; const states = [];
  const client = { listArchitectureClarifications: () => new Promise((resolve, reject) => requests.push({ resolve, reject })) };
  const loader = createArchitectureClarificationLoader({ client, projectId: "PROJECT-A", conversationId: "CONV-A", onState: (state) => states.push(state) });
  const first = loader.load(); const second = loader.load();
  requests[1].resolve([{ session_id: "NEW" }]); await second;
  requests[0].resolve([{ session_id: "OLD" }]); await first;
  assert.equal(states.length, 1); assert.equal(states[0].sessions[0].session_id, "NEW");
  const failed = loader.load(); requests[2].reject(new Error("offline")); await failed;
  assert.equal(states[1].sessions[0].session_id, "NEW"); assert.equal(states[1].error, "offline");
  const cancelled = loader.load(); loader.cancel(); requests[3].resolve([]); await cancelled;
  assert.equal(states.length, 2);
});

test("only relevant lifecycle and selected conversation events trigger clarification reconciliation", () => {
  const refresh = (event_type, project_id = "PROJECT-A", conversation_id = "CONV-A") => refreshArchitectureClarifications({ event_type, project_id, payload: { conversation_id } }, "PROJECT-A", "CONV-A");
  assert.equal(refresh("plan.request.awaiting_owner_decisions"), true);
  assert.equal(refresh("stream.connected"), true);
  assert.equal(refresh("conversation.message.completed"), true);
  assert.equal(refresh("conversation.message.completed", "PROJECT-A", "CONV-B"), false);
  assert.equal(refresh("plan.request.persisted", "PROJECT-B"), false);
  for (const event of ["conversation.message.delta", "ticket.status.updated", "execution.updated"]) assert.equal(refresh(event), false);
});

test("owner credentials remain headers and retry targets the sealed confirmation version", async () => {
  const calls = [];
  const client = createArchitectureClarificationClient({ forgeV1: (path, query) => `${path}?project=${query.project}`, requestJson: async (...args) => { calls.push(args); return []; } });
  const session = { session_id: "CLARIFY-A", version: 4, source_sha256: "a".repeat(64) };
  await client.listArchitectureClarifications("PROJECT-A", "CONV/A");
  await client.saveArchitectureChoices("PROJECT-A", "CONV/A", session, { STORAGE: "LOCAL" }, {}, "SECRET");
  await client.confirmArchitectureChoices("PROJECT-A", "CONV/A", { ...session, status: "generation_failed", confirmation_version: 2 }, "SECRET");
  assert.match(calls[0][0], /CONV%2FA\/plan-clarifications/);
  assert.equal(calls[1][1].headers.authorization, "Bearer SECRET");
  assert.equal(calls[1][1].body.includes("SECRET"), false);
  assert.equal(JSON.parse(calls[1][1].body).version, 4);
  assert.equal(JSON.parse(calls[2][1].body).version, 2);
});

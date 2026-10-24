/** Verifies direct Owner responses carry authentication and the exact displayed
 * request binding while existing AM decision requests retain their own endpoint. */
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketHumanReviewClient } from "../lib/ticket-human-review-client.js";

test("Owner response uses a separate authenticated endpoint and sends only the displayed binding and answer", async () => {
  const calls = [];
  const client = createTicketHumanReviewClient({ forgeV1: (path, query) => `${path}?project=${query.project}`,
    requestJson: async (path, options) => { calls.push({ path, options }); return { status: "recorded" }; } });
  await client.respondTicketBlocker("P", "T", { request_id: "Q", job_id: "J", execution_id: "E", answer: "Direct answer", token: "fixture-token" });
  assert.equal(calls[0].path, "/tickets/T/blocker-response?project=P");
  assert.equal(calls[0].options.headers.authorization, "Bearer fixture-token");
  assert.deepEqual(JSON.parse(calls[0].options.body), { project_id: "P", request_id: "Q", job_id: "J", execution_id: "E", answer: "Direct answer" });
  assert.doesNotMatch(calls[0].options.body, /fixture-token/);
  await client.decideTicketBlocker("P", "T", { actor: "owner", optionId: "retain", reason: "Existing decision" });
  assert.equal(calls[1].path, "/tickets/T/blocker-decision?project=P");
});

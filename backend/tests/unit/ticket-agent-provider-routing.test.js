// Confirms approved ticket contracts bind Coder and Reviewer dispatch to signed profiles.
import assert from "node:assert/strict";
import test from "node:test";
import { selectTicketCoder, selectTicketReviewer } from "../../src/modules/supervisor/ticket-agent-provider-routing.js";

const earlyCoder = { agent_id: "early", role: "coder", enabled: true, status: "ready", provider: "codex" };
const signedCoder = { agent_id: "signed", role: "coder", enabled: true, status: "ready", provider: "claude" };
const earlyReviewer = { agent_id: "early-reviewer", role: "reviewer", enabled: true, status: "ready" };
const signedReviewer = { agent_id: "signed-reviewer", role: "reviewer", enabled: true, status: "ready" };
const ticket = { execution_contract: { coder: signedCoder.agent_id, reviewer: signedReviewer.agent_id } };

test("ticket claims only its signed Coder even when another is ready first", async () => {
  const claimed = [];
  const resolver = { list: () => [earlyCoder, signedCoder], resolveAvailable: () => earlyCoder };
  const occupancy = { getByTask: () => null, claim: async ({ agentId }) => { claimed.push(agentId); return { claim_id: "claim", agent_id: agentId }; } };
  const result = await selectTicketCoder({ resolver, occupancy, ticket, taskId: "A5", ownerId: "SUP-A5", role: "coder", payload: {} });
  assert.equal(result.selected.agent_id, signedCoder.agent_id);
  assert.deepEqual(claimed, [signedCoder.agent_id]);
});

test("signed Coder unavailable prevents claim or fallback dispatch", async () => {
  let claims = 0;
  const resolver = { list: () => [earlyCoder, { ...signedCoder, status: "working" }], resolveAvailable: () => earlyCoder };
  const occupancy = { getByTask: () => null, claim: async () => { claims += 1; return null; } };
  await assert.rejects(selectTicketCoder({ resolver, occupancy, ticket, taskId: "A5", ownerId: "SUP-A5", role: "coder", payload: {} }), { code: "AGENT_NOT_AVAILABLE" });
  assert.equal(claims, 0);
});

test("review binds to its signed Reviewer and rejects another retained claim", () => {
  const resolver = { list: () => [earlyReviewer, signedReviewer], resolveAvailable: () => earlyReviewer };
  assert.equal(selectTicketReviewer(resolver, ticket).agent_id, signedReviewer.agent_id);
  assert.throws(() => selectTicketReviewer(resolver, ticket, { agent_id: earlyReviewer.agent_id }), { code: "REVIEWER_NOT_AVAILABLE" });
});

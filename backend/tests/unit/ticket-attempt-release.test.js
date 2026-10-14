// Verifies ended ticket attempts free both resource types without discarding their resumable journal.
import assert from "node:assert/strict";
import test from "node:test";
import { releaseTicketAttempt } from "../../src/modules/supervisor/ticket-attempt-release.js";

// Preserves Coder source history and releases the exact agent claim before making retry available.
test("settled attempt releases files reversibly and only its owned agent claim", async () => {
  const actions = [];
  await releaseTicketAttempt({ workspace: { changeLedger: { release: async (options) => actions.push(options) } },
    agentOccupancy: { release: async (identity) => actions.push(identity) }, claim: { claim_id: "CLAIM-A" }, taskId: "TICKET-A", ownerId: "SUP-A", reason: "ticket_failed" });
  assert.deepEqual(actions, [{ close: false }, { claimId: "CLAIM-A", taskId: "TICKET-A", supervisorId: "SUP-A", reason: "ticket_failed" }]);
});

// Prevents a filesystem cleanup error from leaving the terminal attempt's agent permanently working.
test("agent is released even if file cleanup fails and the error remains visible", async () => {
  const error = Object.assign(new Error("Cannot release claim"), { code: "EACCES" });
  let released = false;
  await assert.rejects(releaseTicketAttempt({ workspace: { changeLedger: { release: async () => { throw error; } } },
    agentOccupancy: { release: async () => { released = true; } }, claim: { claim_id: "CLAIM-A" }, taskId: "TICKET-A", ownerId: "SUP-A", reason: "ticket_failed" }), error);
  assert.equal(released, true);
});

// Verifies SDK failures keep Coder progress resumable without requesting a human review verdict.
import assert from "node:assert/strict";
import test from "node:test";
import { handleTicketExecutionFailure } from "../../src/modules/supervisor/ticket-execution-failure.js";

// Runs the terminal failure handler against an existing Coder checkpoint.
async function runFailure(code, message) {
  const published = [];
  const releases = [];
  let checkpoint = { task_id: "TICKET-1", status: "blocked", last_completed_turn: 37, changed_paths: ["ui/nextjs/app/page.jsx"], failure: { code, message } };
  await handleTicketExecutionFailure({
    error: Object.assign(new Error(message), { code }),
    failedRequest: { task_id: "TICKET-1", request_id: "REQ-1", correlation_id: "CORR-1", payload: {} },
    selected: { agent_id: "CODER-1", agent_name: "Coder" },
    claim: { claim_id: "CLAIM-1" }, taskId: "TICKET-1", ownerId: "SUP-1",
    checkpoints: { load: async () => checkpoint, save: async (value) => { checkpoint = value; } },
    agentOccupancy: { release: async (value) => releases.push(value) },
    projectLogger: () => {},
    publishTicketOutcome: async (type, _request, _owner, payload) => published.push({ type, payload })
  });
  return { checkpoint, published, releases };
}

// Treats SDK timeout after partial Coder work as a retryable failed RUN.
test("Codex timeout fails the ticket and preserves changed paths for resume", async () => {
  const result = await runFailure("CONFIGURATION_ERROR", "Codex SDK request timed out for CODER-1.");
  assert.equal(result.published[0].type, "task.failed");
  assert.equal(result.checkpoint.status, "failed");
  assert.equal(result.checkpoint.last_completed_turn, 37);
  assert.deepEqual(result.checkpoint.changed_paths, ["ui/nextjs/app/page.jsx"]);
  assert.equal(result.releases.length, 1);
});

// Keeps scope failures resumable while retaining the original failure evidence.
test("scope failure becomes a resumable failed run", async () => {
  const result = await runFailure("TICKET_BASELINE_SCOPE", "Attempted write outside the approved manifest.");
  assert.equal(result.published[0].type, "task.failed");
  assert.equal(result.published[0].payload.retryable, true);
  assert.equal(result.checkpoint.status, "failed");
});

/** Exercises phase status validation and the shared exchange route so a phase
 * yield cannot impersonate completion, change execution identity or consult AM. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentExchange, bindAgentExchangeResponse } from "../../src/modules/governance/agent-exchange.js";
import { createAgentExchangeStorage } from "../../src/modules/governance/agent-exchange-storage.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { parseTicketWorkProgress, TICKET_WORK_PROGRESS_PROMPT } from "../../src/modules/supervisor/ticket/ticket-work-progress.js";

/** Creates the same four model-authored fields used by both provider prompts. */
function content() {
  return { kind: "work_progress", subject: "Discovery complete", payload: { status: "discovery_complete", next_action: "implement", summary: "Relevant source found", remaining_work: ["Implement the approved ticket"] }, evidence: [] };
}

/** Supplies a Node-owned current assignment with immutable execution identity. */
function assignment() {
  return createAgentExchange({ context: { project_id: "PROJECT", ticket_id: "TASK", execution_id: "RUN" }, sender: { agent_id: "NODE", role: "node" }, recipient: { agent_id: "CODER", role: "coder" },
    kind: "work_request", subject: "Implement the ticket", payload: { objective: "Implement", criterion_ids: ["AC-1"], decision_refs: [], remaining_work: ["Implement"], expected_outputs: ["A report_done result"] } });
}

// Progress binds to the original assignment rather than creating a new work or approval request.
test("phase status is bound and persisted under the current shared assignment", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "forge-work-progress-")); context.after(() => rm(root, { recursive: true, force: true }));
  const request = assignment(); const storage = createAgentExchangeStorage({ fileService: createFileService({ projectRoot: root }) });
  await storage.save(request);
  const response = parseTicketWorkProgress(JSON.stringify(content()), request);
  assert.equal(response.kind, "work_progress"); assert.equal(response.recipient.role, "node");
  assert.equal(response.in_reply_to, request.message_id); assert.deepEqual(response.context, request.context);
  await storage.save(response);
  assert.deepEqual(await storage.read(request.context, response.message_id), response);
});

// The schema links each reported phase to exactly one nonterminal next action.
test("schema rejects fabricated completion, mismatched phases and identity fields", () => {
  for (const change of [
    { payload: { ...content().payload, status: "completed" } },
    { payload: { ...content().payload, next_action: "report" } },
    { payload: { ...content().payload, approved: true } },
    { context: { execution_id: "OTHER" } },
    { evidence: [{ type: "decision", ref: "invented", purpose: "Bypass approval" }] }
  ]) assert.throws(() => parseTicketWorkProgress(JSON.stringify({ ...content(), ...change }), assignment()));
  assert.throws(() => parseTicketWorkProgress("Discovery complete. Moving to implementation"));
  assert.match(TICKET_WORK_PROGRESS_PROMPT, /Exact work_progress payload JSON Schema/);
  assert.match(TICKET_WORK_PROGRESS_PROMPT, /"additionalProperties":false/);
});

// A progress response is an execution status for Node, never a shortcut to SL, AM or Owner authority.
test("work progress cannot be routed to another coordinating authority", () => {
  const request = assignment();
  for (const role of ["sprint_leader", "architecture_manager", "project_owner"]) assert.throws(() => createAgentExchange({ context: request.context,
    sender: request.recipient, recipient: { agent_id: role, role }, kind: "work_progress", subject: "Progress", payload: content().payload, inReplyTo: request.message_id }), { code: "AGENT_EXCHANGE_INVALID" });
  const response = bindAgentExchangeResponse(content(), request);
  assert.throws(() => bindAgentExchangeResponse({ ...response, context: { ...response.context, execution_id: "OTHER" } }, request), { code: "AGENT_EXCHANGE_INVALID" });
});

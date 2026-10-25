// Verifies autonomy reminders reach planning, both Coder providers, repair, Resume, and review without weakening contracts.
import assert from "node:assert/strict";
import test from "node:test";
import { CODER_AUTONOMY_PROMPT, PLANNING_AUTONOMY_PROMPT, REVIEW_AUTONOMY_PROMPT } from "../../src/shared/implementation-autonomy.js";
import { buildCodexTicketPrompt, buildToolTicketPrompt, COMPLEXITY_FALLBACK } from "../../src/modules/supervisor/nodeforge-task-prompts.js";
import { buildResumePrompt, checkpointPayload, createResumeState } from "../../src/modules/supervisor/ticket-resume.js";
import { createSprintPlanLeader } from "../../src/application/sprint-plan-leader.js";
import { createTicketSprintLeader } from "../../src/application/ticket-sprint-leader.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

const ticket = { id: "T-AUTONOMY", title: "Return a correct total", objective: "Sum input values", acceptance_criteria: ["Return the sum, including zero for empty input"], verification_plan: [{ criterion_ids: ["AC-1"], kind: "test", test_path: "backend/tests/total.test.js" }] };

test("Codex and Claude preserve the same autonomy and immutable verification boundary", () => {
  const original = structuredClone(ticket);
  for (const build of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
    for (const [directCode, immutableScope] of [[false, false], [true, false], [false, true]]) {
      const prompt = build(ticket, null, ["src/total.js"], COMPLEXITY_FALLBACK, directCode, immutableScope);
      assert.ok(prompt.includes(CODER_AUTONOMY_PROMPT));
      assert.ok(prompt.includes(ticket.acceptance_criteria[0]));
      assert.match(prompt, /AC-1: test \(test_path=backend\/tests\/total\.test\.js\)/);
      assert.match(prompt, /commit_changes/);
      assert.match(prompt, /report_done/);
      if (immutableScope) assert.match(prompt, /edit only manifest paths/);
    }
  }
  assert.deepEqual(ticket, original);
});

// Distinguishes discovery-order advice from the independent edit prerequisite
// for both provider prompts, without weakening the mandatory tool boundary.
test("both Coder prompts distinguish advisory discovery order from mandatory prerequisites", () => {
  for (const build of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
    const prompt = build(ticket, null, ["src/total.js"], COMPLEXITY_FALLBACK);
    assert.match(prompt, /position among discovery calls is advisory/);
    assert.match(prompt, /runtime independently requires a successful rules read before the first edit/);
    assert.match(prompt, /within (?:it|that budget).*discovery is yours to direct|Discovery within that budget is yours to direct/);
    assert.match(prompt, /bounded total-budget extension/);
    assert.match(prompt, /Never change permissions or bypass an actual tool denial/);
  }
});

test("checkpoint roundtrip and review repair retain autonomy without inventing owner approval", () => {
  const state = createResumeState({ status: "failed", last_completed_turn: 23, thread_id: "thread-autonomy", changed_paths: ["src/total.js"], review_findings: [{ finding_id: "REV-1", message: "Empty input must return zero" }] });
  const resumed = createResumeState(checkpointPayload(state, { status: "failed" }));
  const prompt = buildResumePrompt(buildCodexTicketPrompt(ticket, null, ["src/total.js"], COMPLEXITY_FALLBACK, false, true), resumed);
  assert.ok(prompt.includes(CODER_AUTONOMY_PROMPT));
  assert.ok(prompt.includes(ticket.acceptance_criteria[0]));
  assert.match(prompt, /REV-1: Empty input must return zero/);
  assert.match(prompt, /only Reviewer adjudication can close it/);
  assert.doesNotMatch(prompt, /Project owner decided blocker option/);
  assert.equal(resumed.threadId, "thread-autonomy");
  assert.equal(resumed.turnCount, 23);
});

test("Sprint drafting and priority-only repair retain behavioral planning instructions", async () => {
  const calls = [];
  const leader = createSprintPlanLeader({ sdkGateway: { execute: async (input) => {
    calls.push(input);
    return { text: JSON.stringify({ id: "SPRINT-A", tickets: [{ title: "Sum", priority: calls.length === 1 ? 1 : "high", acceptance_criteria: ticket.acceptance_criteria }] }) };
  } }, logger: { info() {}, error() {} } });
  const result = await leader.requestPlan({ projectId: "PROJECT-A", agentId: "sl", brief: "Behavioral total", correlationId: "CORR-A" });
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(call.prompt.includes(PLANNING_AUTONOMY_PROMPT));
  assert.match(calls[1].prompt, /Change ONLY invalid ticket priority/);
  assert.deepEqual(result.tickets[0].acceptance_criteria, ticket.acceptance_criteria);
});

test("ticket creation and regeneration carry the same autonomy boundary", async () => {
  const calls = [];
  const leader = createTicketSprintLeader({ sdkGateway: { execute: async (input) => { calls.push(input); return { text: JSON.stringify(ticket) }; } }, logger: { info() {}, error() {} } });
  for (const feedback of [undefined, "Regenerate the existing draft without weakening criteria"]) {
    await leader.requestTicket({ projectId: "PROJECT-A", agentId: "sl", content: "Sum values", feedback, correlationId: "CORR-A" });
  }
  assert.equal(calls.length, 2);
  for (const call of calls) assert.ok(call.prompt.includes(PLANNING_AUTONOMY_PROMPT));
});

test("review dispatch requires behavior-based findings and still rejects self-review", async () => {
  const calls = [];
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer", provider: "openai" }) },
    openaiSdkGateway: { execute: async (input) => { calls.push(input); return { text: JSON.stringify({ verdict: "approved", findings: [] }) }; } },
    projectRoot: "/project",
    fileService: { readForIndex: async ({ path }) => ({ path, sha256: "sha256:unchanged", content: path.endsWith("README.md") ? "Independent review rules" : "export const total = 0;" }) }
  });
  await worker.review({ task_id: ticket.id, agent_id: "coder", payload: { ticket, changed_paths: ["src/total.js"] } });
  assert.ok(calls[0].prompt.includes(REVIEW_AUTONOMY_PROMPT));
  await assert.rejects(worker.review({ task_id: ticket.id, agent_id: "reviewer", payload: { ticket, changed_paths: ["src/total.js"] } }), { code: "REVIEWER_NOT_AVAILABLE" });
  assert.equal(calls.length, 1);
});

/** Exercises real immutable communication storage when Coder checkpoint work
 * continues under a retained or replacement RUN. Historical requests and answers
 * remain inspectable while only the current assignment can receive new results. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentExchangeStorage } from "../../src/modules/governance/agent-exchange-storage.js";
import { createAgentExchange, bindAgentExchangeResponse } from "../../src/modules/governance/agent-exchange.js";
import { prepareRepairExchange } from "../../src/modules/supervisor/review-agent-exchange.js";
import { withCoderExchange, coderExchangePrompt } from "../../src/modules/supervisor/coder-agent-exchange.js";
import { createResumeState, checkpointPayload } from "../../src/modules/supervisor/ticket-resume.js";

/** Creates an actual Reviewer repair message and checkpoint without an SDK or live runtime mutation. */
async function fixture() {
  const projectRoot = await mkdtemp(join(tmpdir(), "coder-exchange-resume-"));
  const selected = { agent_id: "CODER", role: "coder", provider: "codex" };
  const request = { project_id: "PROJECT-1", task_id: "TICKET-1", request_id: "REQUEST-OLD", payload: { execution_id: "RUN-OLD" },
    ticket: { title: "Complete the missing evidence", acceptance_criteria: ["Focused checks pass"] } };
  const message = await prepareRepairExchange({ request, selected, reviewerId: "REVIEWER", findings: ["REV-1: Return the focused security receipt."], projectRoot });
  const checkpoint = { task_id: request.task_id, status: "failed", agent_id: selected.agent_id, provider: selected.provider, attempt: 6,
    phase: "finding_repair_ready", agent_exchange: message, last_completed_turn: 4, thread_id: "THREAD-SAVED", completed_tools: ["respond_to_review"],
    review_findings: [{ finding_id: "REV-1", status: "open" }], blocker_recovery: { status: "superseded_by_review", communication: { response_id: "obsolete-unused-reference" } } };
  const fileService = createFileService({ projectRoot, role: "system_engineer" });
  const storage = createAgentExchangeStorage({ fileService });
  const input = { ...request, request_id: "REQUEST-NEW", payload: { execution_id: "RUN-NEW", resume_from: checkpoint } };
  return { projectRoot, selected, request, message, checkpoint, input, storage, fileService, close: () => rm(projectRoot, { recursive: true, force: true }) };
}

test("replacement RUN continues the saved repair assignment and writes results under its new context", async () => {
  const f = await fixture();
  try {
    const original = await f.fileService.readFile({ path: `.forge/runtime/agent-messages/TICKET-1/${f.message.message_id}.json` });
    let renewed;
    const run = withCoderExchange(async (_selected, input) => {
      renewed = input.payload.agent_exchange;
      assert.equal(renewed.context.execution_id, "RUN-NEW"); assert.notEqual(renewed.message_id, f.message.message_id);
      assert.deepEqual(renewed.payload, f.message.payload); assert.deepEqual(renewed.sender, f.message.sender);
      assert.equal(input.payload.resume_from.last_completed_turn, 4); assert.equal(input.payload.resume_from.attempt, 6);
      assert.equal(input.payload.agent_consultation, null);
      const state = createResumeState(input.payload.resume_from); state.agentExchange = renewed;
      const saved = checkpointPayload(state);
      assert.equal(saved.thread_id, "THREAD-SAVED"); assert.equal(saved.agent_exchange.message_id, renewed.message_id);
      assert.deepEqual(saved.review_findings, [{ finding_id: "REV-1", status: "open", review_revision: 1, review_history_tool: "query_review" }]);
      return { summary: "The repair explanation is submitted." };
    }, f);
    const result = await run(f.selected, f.input);
    const responseId = result.communication.response_ref.ref.split("/").at(-1).slice(0, -5);
    const response = await f.storage.read(renewed.context, responseId);
    assert.equal(response.in_reply_to, renewed.message_id); assert.equal(response.recipient.role, "reviewer");
    assert.equal(renewed.continuation.assignment_id, f.input.request_id);
    assert(renewed.evidence.some((item) => item.ref.endsWith(`/${f.message.message_id}.json`)));
    assert.equal(await f.fileService.readFile({ path: `.forge/runtime/agent-messages/TICKET-1/${f.message.message_id}.json` }), original);
    await assert.rejects(f.storage.read(renewed.context, f.message.message_id), /context changed/);
    await run(f.selected, f.input);
    assert.equal((await f.storage.read(response.context, responseId)).in_reply_to, renewed.message_id);
  } finally { await f.close(); }
});

test("resume cannot consume another project, ticket, Coder, or an assignment absent from its checkpoint", async () => {
  const f = await fixture();
  try {
    let calls = 0;
    const run = withCoderExchange(async () => { calls++; }, f);
    for (const input of [{ ...f.input, project_id: "OTHER" }, { ...f.input, task_id: "OTHER" },
      { ...f.input, payload: { ...f.input.payload, agent_exchange: f.message, resume_from: { ...f.checkpoint, agent_exchange: null } } },
      { ...f.input, payload: { execution_id: "RUN-NEW", agent_exchange: f.message } },
      { ...f.input, payload: { ...f.input.payload, resume_from: { ...f.checkpoint, task_id: "OTHER" } } }]) await assert.rejects(run(f.selected, input));
    await assert.rejects(run({ ...f.selected, agent_id: "OTHER" }, f.input));
    const corrupt = structuredClone(f.input); corrupt.payload.resume_from.agent_exchange.payload.remaining_work = ["Fabricated work"];
    await assert.rejects(run(f.selected, corrupt), { code: "AGENT_EXCHANGE_INVALID" });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test("resolved SL answers keep their original binding across renewed assignments and subsequent resumes", async () => {
  const f = await fixture();
  try {
    const question = createAgentExchange({ context: f.message.context, sender: { agent_id: f.selected.agent_id, role: "coder" }, recipient: { agent_id: "SL", role: "sprint_leader" },
      kind: "consultation_request", subject: "Which focused check is missing?", payload: { question: "Which focused check is missing?",
        decision_needed: "Identify the existing check.", known_decision_refs: [], impact: "Evidence delivery only." } });
    await f.storage.save(question);
    const answer = bindAgentExchangeResponse({ kind: "consultation_response", subject: "Use the existing security check.", evidence: [],
      payload: { outcome: "answered", answer: "Run the existing security check.", rationale: "Approved coverage is unchanged.", authority_refs: [], next_steps: ["Return its receipt."] } }, question);
    await f.storage.save(answer);
    f.checkpoint.blocker_recovery = { status: "resolved", communication: { response_id: answer.message_id } };
    let renewed;
    const run = withCoderExchange(async (_selected, input) => {
      renewed = input.payload.agent_exchange;
      assert.equal(input.payload.agent_consultation.message_id, answer.message_id);
      assert.equal(input.payload.agent_consultation.context.execution_id, "RUN-OLD");
      assert.match(coderExchangePrompt(input), /historical answers are not new execution permission/);
      return { summary: "Evidence returned." };
    }, f);
    await run(f.selected, f.input);
    await run(f.selected, { ...f.input, payload: { ...f.input.payload, resume_from: { ...f.checkpoint, agent_exchange: renewed } } });
    const wrongQuestion = createAgentExchange({ ...question, sender: { agent_id: "OTHER", role: "coder" } });
    await f.storage.save(wrongQuestion);
    const wrongAnswer = bindAgentExchangeResponse({ kind: "consultation_response", subject: answer.subject, evidence: [], payload: answer.payload }, wrongQuestion);
    await f.storage.save(wrongAnswer);
    f.checkpoint.blocker_recovery.communication.response_id = wrongAnswer.message_id;
    await assert.rejects(run(f.selected, f.input), /does not answer this Coder/);
  } finally { await f.close(); }
});

test("Stop cannot renew an assignment or dispatch Coder", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort(Object.assign(new Error("Stopped by owner"), { code: "TICKET_STOPPED" }));
    const run = withCoderExchange(async () => assert.fail("No Coder dispatch"), f);
    await assert.rejects(run(f.selected, { ...f.input, abortSignal: controller.signal }), { code: "TICKET_STOPPED" });
  } finally { await f.close(); }
});

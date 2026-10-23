/** Checks durable Coder work assignments across resume, review repair, failed
 * execution and Stop without replacing the executor's governed completion gate. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { withCoderExchange, coderExchangePrompt } from "../../src/modules/supervisor/coder-agent-exchange.js";
import { prepareRepairExchange } from "../../src/modules/supervisor/review-agent-exchange.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createAgentExchangeStorage } from "../../src/modules/governance/agent-exchange-storage.js";
import { createAgentExchange, bindAgentExchangeResponse } from "../../src/modules/governance/agent-exchange.js";
import { createResumeState, checkpointPayload } from "../../src/modules/supervisor/ticket-resume.js";

const selected = { agent_id: "C", role: "coder" };
const request = { project_id: "P", task_id: "T", request_id: "R", payload: { execution_id: "E" }, ticket: { title: "Repair binding", objective: "Bind the reply", acceptance_criteria: ["Correct binding"] } };

test("Coder resume retains request identity and turn progress before a typed result", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coder-exchange-"));
  try {
    let pending, message;
    const fail = withCoderExchange(async (_, input) => {
      pending = input;
      message = input.payload.agent_exchange;
      assert.match(coderExchangePrompt(input), /never consult AM directly/);
      throw Object.assign(new Error("Blocked on a specific contract question."), { code: "CODER_BLOCKED" });
    }, { projectRoot });
    await assert.rejects(fail(selected, request), { code: "CODER_BLOCKED" });
    const state = createResumeState({ status: "blocked", last_completed_turn: 82, completed_tools: ["edit_diff"] });
    state.agentExchange = message;
    const checkpoint = checkpointPayload(state);
    const storage = createAgentExchangeStorage({ fileService: createFileService({ projectRoot, role: "system_engineer" }) });
    const question = createAgentExchange({ context: message.context, sender: selected, recipient: { agent_id: "SL", role: "sprint_leader" },
      kind: "consultation_request", subject: "Which binding should be retained?", payload: { question: "Which binding should be retained?",
        decision_needed: "Choose the approved binding.", known_decision_refs: [], impact: "One repair awaits this choice." } });
    await storage.save(question);
    const answer = bindAgentExchangeResponse({ kind: "consultation_response", subject: "Reuse the existing approved binding.", evidence: [],
      payload: { outcome: "answered", answer: "Reuse the existing approved binding.", rationale: "It satisfies the settled contract.", authority_refs: [], next_steps: ["Repair the missing assertion."] } }, question);
    await storage.save(answer);
    checkpoint.blocker_recovery = { communication: { response_id: answer.message_id } };
    assert.equal(checkpoint.last_completed_turn, 82);
    let resumed = false;
    const run = withCoderExchange(async (_, input) => {
      resumed = true;
      assert.equal(input.payload.agent_exchange.message_id, message.message_id);
      assert.equal(input.payload.resume_from.last_completed_turn, 82);
      assert.match(coderExchangePrompt(input), /SL ANSWER TO YOUR RETAINED QUESTION/);
      assert.equal(input.payload.agent_consultation.message_id, answer.message_id);
      return { summary: "Report submitted through report_done.", tool_events: [] };
    }, { projectRoot });
    const result = await run(selected, { ...request, payload: { ...request.payload, resume_from: checkpoint } });
    assert.equal(resumed, true);
    const saved = JSON.parse(await createFileService({ projectRoot, role: "system_engineer" }).readFile({ path: result.communication.response_ref.ref }));
    assert.equal(saved.in_reply_to, pending.payload.agent_exchange.message_id);
    assert.equal((await storage.read(message.context, saved.message_id)).payload.outcome, "completed");
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test("repair result returns to Reviewer, and wrong execution cannot consume its assignment", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "coder-repair-exchange-"));
  try {
    const message = await prepareRepairExchange({ request, selected, reviewerId: "R", findings: ["Repair one missing assertion."], projectRoot });
    let calls = 0;
    const run = withCoderExchange(async () => { calls++; return { summary: "Repair report submitted." }; }, { projectRoot });
    const result = await run(selected, { ...request, payload: { ...request.payload, agent_exchange: message } });
    const storage = createAgentExchangeStorage({ fileService: createFileService({ projectRoot, role: "system_engineer" }) });
    const answer = await storage.read(message.context, result.communication.response_ref.ref.split("/").at(-1).replace(/\.json$/, ""));
    assert.equal(answer.recipient.role, "reviewer");
    await assert.rejects(run(selected, { ...request, payload: { execution_id: "OTHER", agent_exchange: message } }), /context changed/);
    assert.equal(calls, 1);
    const controller = new AbortController(); controller.abort(new Error("Owner Stop"));
    await assert.rejects(run(selected, { ...request, abortSignal: controller.signal, payload: { ...request.payload, agent_exchange: message } }), /Owner Stop/);
    assert.equal(calls, 1);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

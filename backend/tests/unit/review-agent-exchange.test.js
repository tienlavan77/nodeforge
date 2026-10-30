/** Exercises the shared review contract through the existing verdict parser and
 * correction service, retaining independent judgment and durable request binding. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prepareReviewExchange, saveReviewExchange, prepareRepairExchange } from "../../src/modules/supervisor/review/review-agent-exchange.js";
import { parseReviewVerdict } from "../../src/modules/supervisor/review/review-verdict-contract.js";
import { requestReviewVerdict } from "../../src/modules/supervisor/review/review-verdict-request.js";

const job = { id: "J", request_id: "R", project_id: "P", task_id: "T", agent_id: "C", payload: { execution_id: "E", ticket: { acceptance_criteria: ["Works"] } } };
const reviewer = { agent_id: "R", role: "reviewer" };
const reply = { kind: "review_result", subject: "All ticket criteria pass.", evidence: [],
  payload: { verdict: "approved", summary: "All ticket criteria pass.", findings: [], finding_updates: [] } };

test("Reviewer v1 result is bound to its source and existing verdict validation", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "review-exchange-"));
  try {
    const communication = await prepareReviewExchange({ job, reviewer, sourceRef: "commit-one", coderReport: { artifact_id: "A" }, exchange: { findings: [] }, projectRoot });
    assert.equal(communication.request.sender.role, "coder");
    assert.equal(communication.request.payload.source_ref, "commit-one");
    const verdict = parseReviewVerdict(JSON.stringify(reply), { exchangeRequest: communication.request });
    assert.deepEqual(verdict, { verdict: "approved", findings: [], adjudications: [] });
    const record = await saveReviewExchange(communication, verdict);
    const restored = await communication.storage.read(communication.request.context, record.response_id);
    assert.equal(restored.in_reply_to, communication.request.message_id);
    assert.equal(restored.recipient.agent_id, job.agent_id);
    assert.throws(() => parseReviewVerdict(JSON.stringify({ ...reply, context: { execution_id: "OTHER" } }), { exchangeRequest: communication.request }), { code: "REVIEW_VERDICT_INVALID" });
    assert.throws(() => parseReviewVerdict(`Narrative\n${JSON.stringify({ ...reply, kind: "work_result" })}`, { exchangeRequest: communication.request }), { code: "REVIEW_VERDICT_INVALID" });
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test("Reviewer correction does not resend source or restart discovery", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "review-correction-"));
  try {
    const communication = await prepareReviewExchange({ job, reviewer, sourceRef: "commit-one", exchange: { findings: [] }, projectRoot });
    let calls = 0, revalidations = 0;
    const attempts = [];
    const result = await requestReviewVerdict({ prompt: `${communication.prompt}\nUNRELATED-LARGE-SOURCE`, communication,
      parseOptions: { exchangeRequest: communication.request }, exchange: { findings: [] },
      execute: async (prompt, correction) => {
        calls++;
        if (calls === 1) return { text: "{invalid-json" };
        assert.equal(correction, true);
        assert.match(prompt, /"kind":"correction"/);
        assert.match(prompt, /FORMAT CORRECTION ONLY/);
        assert.doesNotMatch(prompt, /UNRELATED-LARGE-SOURCE/);
        return { text: JSON.stringify(reply) };
      }, onAttempt: async (attempt) => attempts.push(attempt), revalidate: async () => { revalidations++; } });
    assert.equal(result.verdict, "approved");
    const saved = await saveReviewExchange(communication, result);
    const restored = await communication.storage.read(communication.request.context, saved.response_id);
    assert.equal(restored.subject, reply.subject);
    assert.equal(restored.payload.summary, reply.payload.summary);
    assert.equal(revalidations, 1);
    assert.deepEqual(attempts.map((attempt) => attempt.status), ["invalid", "valid"]);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

test("finding repair routes Reviewer -> Coder with the exact minimum scope", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "repair-exchange-"));
  try {
    const request = { ...job, ticket: job.payload.ticket };
    const message = await prepareRepairExchange({ request, selected: { agent_id: "C" }, reviewerId: "R", projectRoot,
      findings: [{ finding_id: "REV-1", minimum_change_scope: "Repair only the missing request binding." }], reviewRef: "review-verdict-one" });
    assert.equal(message.sender.role, "reviewer");
    assert.equal(message.recipient.role, "coder");
    assert.equal(message.continuation.assignment_id, job.request_id);
    assert.match(message.payload.remaining_work[0], /^REV-1: Repair only/);
    assert.deepEqual(message.payload.decision_refs, ["review-verdict-one"]);
  } finally { await rm(projectRoot, { recursive: true, force: true }); }
});

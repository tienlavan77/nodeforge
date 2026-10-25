/** Checks that the shared schema adds only AM-requested independent evidence;
 * formal Coder/Reviewer review and the prohibition on direct higher-authority
 * consultations remain intact for both new and retained agent messages. */
import assert from "node:assert/strict";
import test from "node:test";
import { createAgentExchange, bindAgentExchangeResponse, assertAgentExchangePayload } from "../../src/modules/governance/agent-exchange.js";

const context = { project_id: "P", ticket_id: "T", execution_id: "E" };
const subject = { commit_sha: "a".repeat(40), artifact_id: "ARTIFACT-A" };
const payload = { purpose: "blocker_evidence", question: "Compare exact source checksums.", subject, source_ref: subject.commit_sha,
  criterion_ids: [], report_ref: null, finding_refs: [] };
const report = { kind: "review_result", subject: "Comparison recorded.", evidence: [], payload: { purpose: "blocker_evidence", subject,
  outcome: "inconclusive", summary: "Missing recorded dependency.", observations: ["Committed source is available."], missing_evidence: ["Dependency snapshot."], findings: [], finding_updates: [] } };

/** Uses Node-assigned identities to bind review transport to its original
 * question; model-authored responses never select their own recipient. */
function request(role = "architecture_manager", input = payload) {
  return createAgentExchange({ context, sender: { role, agent_id: role }, recipient: { role: "reviewer", agent_id: "RV" },
    kind: "review_request", subject: "Independent evidence", payload: input });
}

test("AM evidence requests bind the result back to AM, the execution and the exact subject", () => {
  const input = request(), result = bindAgentExchangeResponse(report, input);
  assert.equal(result.recipient.role, "architecture_manager");
  assert.equal(result.in_reply_to, input.message_id);
  assert.deepEqual(result.context, context);
  for (const change of [{ ...subject, commit_sha: "b".repeat(40) }, { ...subject, artifact_id: "ARTIFACT-OTHER" }])
    assert.throws(() => bindAgentExchangeResponse({ ...report, payload: { ...report.payload, subject: change } }, input), /requested purpose, commit and artifact/);
});

test("independent evidence cannot be relabeled formal approval or used by another requesting role", () => {
  for (const role of ["coder", "sprint_leader", "node"]) assert.throws(() => request(role), /Forbidden agent route/);
  const formalRequest = { source_ref: subject.commit_sha, criterion_ids: ["AC-1"], report_ref: "REPORT", finding_refs: [] };
  assert.throws(() => request("architecture_manager", formalRequest), /Forbidden agent route/);
  const coder = request("coder", formalRequest);
  const formalReport = { kind: "review_result", subject: "Review complete.", payload: { verdict: "approved", summary: "Accepted.", findings: [], finding_updates: [] }, evidence: [] };
  assert.equal(bindAgentExchangeResponse(formalReport, coder).recipient.role, "coder");
  assert.throws(() => bindAgentExchangeResponse(formalReport, request()));
  assert.throws(() => bindAgentExchangeResponse(report, coder));
});

test("shared schema rejects unbound or mutating evidence requests and reports", () => {
  for (const input of [{ ...payload, subject: undefined }, { ...payload, question: undefined }, { ...payload, subject: { ...subject, commit_sha: "HEAD" } }])
    assert.throws(() => assertAgentExchangePayload("review_request", input));
  for (const patch of [{ verdict: "approved" }, { findings: [{ id: "REV-1" }] }, { finding_updates: [{ status: "closed" }] }, { observations: [] }])
    assert.throws(() => assertAgentExchangePayload("review_result", { ...report.payload, ...patch }));
  const decision = { action: "reconciliation_required", summary: "Need inspection.", reconciliation: { kind: "source_revision", prerequisite: "Evidence.",
    completed_checks: ["Scope settled."], next_check: "Inspect.", waiting_for: [{ owner: "reviewer", operation: "execute", question: "Run a test.", subject }] } };
  assert.throws(() => assertAgentExchangePayload("consultation_response", { outcome: "needs_evidence", answer: "Inspect.", rationale: "Missing facts.",
    authority_refs: [], next_steps: [], missing_evidence: [{ needed: "Evidence", needed_for: "Decision" }], decision }));
});

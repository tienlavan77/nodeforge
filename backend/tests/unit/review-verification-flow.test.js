/** Verifies that typed evidence gaps stay in Node/Reviewer coordination, resume
 * their saved intent and reject repeated requests without replaying Coder work. */
import assert from "node:assert/strict";
import test from "node:test";
import { requestReviewWithVerification, addReviewVerificationEvidence } from "../../src/modules/supervisor/review/review-verification-flow.js";
import { assertReviewVerificationRequests, reviewVerificationRequestSchema } from "../../src/modules/supervisor/review/review-verification-contract.js";
import { createRespondToReviewTool, respondToReviewInputSchema } from "../../src/tools/reporting/respond-to-review-tool.js";
import { createAgentExchange, bindAgentExchangeResponse } from "../../src/modules/governance/agent-exchange.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";
import { beginAutomaticReview } from "../../src/modules/supervisor/review/automatic-review-stage.js";
import { createReviewExchangeEvidence, attachReviewExchangeTools } from "../../src/modules/supervisor/review/review-exchange-evidence.js";
import { createReviewerForgeTools } from "../../src/modules/supervisor/review/reviewer-forge-tools.js";

const artifact = { artifact_id: "ARTIFACT-A", commit_sha: "a".repeat(40), source_revision: "source-1", status: "passed" };
const request = { finding_ids: ["REV-1"], criterion_ids: ["AC-1"], test_paths: ["backend/tests/unit/security.test.js"], scope: "ticket",
  reason: "Focused security coverage is missing.", artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, source_revision: artifact.source_revision };
const required = { verdict: "verification_required", findings: [], adjudications: [], verification_requests: [request] };
const approved = { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed", reason: "Node receipt covers the criterion.", evidence_refs: ["CHECK-1"] }] };

/** Captures SDK and Node calls separately so a repeated implementation round cannot be mistaken for progress. */
function fixture(responses = [required, approved]) {
  const prompts = [], saved = [], checks = [];
  const exchange = { findings: [{ finding_id: "REV-1" }], coder_responses: [], adjudications: [] };
  const exchangeEvidence = { taskId: "TICKET-A", files: new Map() };
  const input = { evidence: { artifact }, exchange, exchangeEvidence,
    job: { task_id: "TICKET-A", payload: { execution_id: "EXECUTION-A", ticket: { acceptance_criteria: ["Security checks pass"] } } },
    options: { prompt: "Review current evidence.", parseOptions: { findingIds: ["REV-1"] }, onAttempt: async () => {}, revalidate: async () => {},
      execute: async (prompt) => { prompts.push(prompt); return { text: JSON.stringify(responses.shift() ?? approved) }; } },
    verificationService: { runReviewVerification: async (input) => {
      checks.push(input);
      return input.requests.map((part) => ({ check_id: "CHECK-1", status: "passed", artifact_id: artifact.artifact_id,
        commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, environment: { sha256: "env" },
        finding_ids: part.finding_ids, commands: [{ exit_code: 0, test_paths: part.test_paths }] }));
    } }, save: async (state) => saved.push(structuredClone(state)) };
  return { input, prompts, saved, checks };
}

test("Reviewer verification requests run once and return to Reviewer before final adjudication", async () => {
  const f = fixture();
  const result = await requestReviewWithVerification(f.input);
  assert.equal(result.verdict, "approved"); assert.equal(f.checks.length, 1); assert.equal(f.prompts.length, 2);
  assert.equal(f.checks[0].executionId, "EXECUTION-A"); assert.equal(f.checks[0].artifact.commit_sha, artifact.commit_sha);
  assert.match(f.prompts[1], /NODE REVIEW VERIFICATION RESULTS/);
  assert.equal(f.saved[0].review_verification.status, "running");
  assert.equal(f.saved[1].review_verification.status, "completed");
  assert.equal(f.input.exchangeEvidence.files.size, 1);
});

test("test-induced source mutations return a failed receipt to Reviewer for an explicit repair verdict", async () => {
  const repair = { verdict: "request_changes", adjudications: [], findings: [{ acceptance_criterion: "AC-1",
    failure: "The test recreates a removed file in its working directory.", evidence_refs: ["CHECK-1"],
    minimum_change_scope: "Keep fixture writes inside the isolated test directory." }] };
  const f = fixture([required, repair]);
  const run = f.input.verificationService.runReviewVerification;
  f.input.verificationService.runReviewVerification = async (input) => (await run(input)).map((receipt) => ({ ...receipt,
    status: "failed", integrity_error: { code: "VERIFY_SOURCE_MISMATCH", path: "x", expected_sha256: null,
      observed_sha256: "sha256:empty", phase: "after_checks", message: "Review verification source differs: x." } }));
  const result = await requestReviewWithVerification(f.input);
  assert.equal(result.verdict, "request_changes");
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /"status":"failed".*"integrity_error"/);
  assert.match(f.prompts[1], /"path":"x"/);
  assert.match(f.prompts[1], /not passing evidence even if the command exited zero/);
  assert.equal(f.saved.at(-1).review_verification.status, "completed");
  assert.equal(f.checks.length, 1);
});

test("structured Coder evidence requests run before Reviewer while prose-only requests launch nothing", async () => {
  const f = fixture([approved]);
  const identity = { artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha, source_revision: artifact.source_revision };
  f.input.exchange.coder_responses.push({ ...identity, idempotency_key: "response-1", responses: [{ finding_id: "REV-1", verification_requests: [request] }] });
  await requestReviewWithVerification(f.input);
  assert.equal(f.checks.length, 1); assert.match(f.prompts[0], /CHECK-1/);
  const prose = fixture([approved]);
  prose.input.exchange.coder_responses.push({ ...identity, idempotency_key: "response-1", responses: [{ finding_id: "REV-1", rationale: "Ask SL to run security tests." }] });
  await requestReviewWithVerification(prose.input);
  assert.equal(prose.checks.length, 0);
  const stale = fixture([approved]);
  stale.input.exchange.coder_responses.push({ ...identity, artifact_id: "ARTIFACT-OLDER", idempotency_key: "old-response",
    responses: [{ finding_id: "REV-1", verification_requests: [{ ...request, artifact_id: "ARTIFACT-OLDER" }] }] });
  await requestReviewWithVerification(stale.input);
  assert.equal(stale.checks.length, 0);
});

test("restart restores pending verification intent before asking Reviewer for a final answer", async () => {
  const f = fixture([approved]);
  f.input.previous = { binding: { artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, source_revision: artifact.source_revision, execution_id: "EXECUTION-A" }, requests: [request], status: "running" };
  await requestReviewWithVerification(f.input);
  assert.equal(f.checks.length, 1); assert.match(f.prompts[0], /NODE REVIEW VERIFICATION RESULTS/);
});

test("an identical repeated request gets a Reviewer correction instead of another test or Coder round", async () => {
  const f = fixture([required, { ...required, verification_requests: [{ ...request, reason: "Same gap restated." }] }, approved]);
  const result = await requestReviewWithVerification(f.input);
  assert.equal(result.verdict, "approved"); assert.equal(f.checks.length, 1);
  assert.equal(f.prompts.length, 3); assert.match(f.prompts[2], /exact Node receipt.*already supplied/);
});

test("unknown finding or criterion and Stop cannot launch or continue verification", async () => {
  for (const patch of [{ finding_ids: ["REV-99"] }, { criterion_ids: ["AC-99"] }]) {
    assert.throws(() => assertReviewVerificationRequests([{ ...request, ...patch }], { artifact, findingIds: ["REV-1"], criterionIds: ["AC-1"] }), { code: "REVIEW_VERDICT_INVALID" });
  }
  const f = fixture(); const controller = new AbortController(); f.input.job.abortSignal = controller.signal;
  f.input.verificationService.runReviewVerification = async () => { controller.abort(Object.assign(new Error("Stopped"), { code: "TICKET_STOPPED" })); return []; };
  await assert.rejects(requestReviewWithVerification(f.input), { code: "TICKET_STOPPED" });
  assert.equal(f.prompts.length, 1);
});

test("shared exchange schema supports typed verification and native structured output", () => {
  const envelope = createAgentExchange({ context: { project_id: "P", ticket_id: "T", execution_id: "E" },
    sender: { agent_id: "C", role: "coder" }, recipient: { agent_id: "R", role: "reviewer" }, kind: "review_request", subject: "Review current source.",
    payload: { source_ref: artifact.commit_sha, criterion_ids: ["AC-1"], report_ref: null, finding_refs: ["REV-1"] } });
  const value = { kind: "review_result", subject: "Security evidence is required.", evidence: [],
    payload: { verdict: "verification_required", summary: "Run the named check.", findings: [], finding_updates: [], verification_requests: [request] } };
  assert.equal(bindAgentExchangeResponse(value, envelope).payload.verdict, "verification_required");
  const native = createAgentExchangeOutput(envelope);
  assert.ok(JSON.stringify(native).includes("verification_required"));
  assert.throws(() => bindAgentExchangeResponse({ ...value, payload: { ...value.payload, verdict: "approved" } }, envelope), { code: "AGENT_EXCHANGE_INVALID" });
  assert.throws(() => bindAgentExchangeResponse({ ...value, payload: { ...value.payload, finding_updates: [{ decision: "fixed" }] } }, envelope), { code: "AGENT_EXCHANGE_INVALID" });
});

test("Coder response persists the same typed contract used in Reviewer output", async () => {
  assert.deepEqual(respondToReviewInputSchema.properties.responses.items.properties.verification_requests.items, reviewVerificationRequestSchema);
  let recorded;
  const tool = createRespondToReviewTool({ verificationService: { assertPassedArtifact: async () => artifact }, reviewFindings: {
    load: async () => ({ coder_reports: [{ artifact_id: artifact.artifact_id, review_commit_sha: artifact.commit_sha }] }),
    recordResponse: async (input) => { recorded = input; return { idempotency_key: input.idempotencyKey }; }
  } });
  const input = { review_commit_sha: artifact.commit_sha, artifact_id: artifact.artifact_id, source_revision: artifact.source_revision,
    idempotency_key: "response-1", responses: [{ finding_id: "REV-1", position: "accept", rationale: "Need a commit-bound check.", files: [], evidence_refs: [artifact.artifact_id], verification_requests: [request] }] };
  await tool.execute(input, { agent_identity: { agent_id: "CODER" } });
  assert.deepEqual(recorded.responses[0].verification_requests, [request]);
  input.responses[0].verification_requests = [{ ...request, commit_sha: "b".repeat(40) }];
  await assert.rejects(tool.execute(input), { code: "REVIEW_VERDICT_INVALID" });
});

test("a failed Node check goes back to Reviewer for judgment rather than being treated as approval", async () => {
  const changes = { verdict: "request_changes", findings: [], adjudications: [{ finding_id: "REV-1", decision: "retain", reason: "Node reproduced the missing security behavior.", evidence_refs: ["CHECK-FAIL"] }] };
  const f = fixture([required, changes]);
  f.input.verificationService.runReviewVerification = async () => [{ check_id: "CHECK-FAIL", status: "failed", commit_sha: artifact.commit_sha,
    source_revision: artifact.source_revision, artifact_id: artifact.artifact_id, finding_ids: ["REV-1"], commands: [{ exit_code: 1 }] }];
  assert.equal((await requestReviewWithVerification(f.input)).verdict, "request_changes");
  assert.equal(f.prompts.length, 2); assert.match(f.prompts[1], /"status":"failed"/);
});

test("review startup preserves pending verification only for its original execution and artifact", async () => {
  const progress = { binding: { artifact_id: artifact.artifact_id, execution_id: "EXECUTION-A" }, requests: [request], status: "running" };
  const saves = [];
  const checkpoints = { loadReview: async () => ({ review_verification: progress }), saveReview: async (value) => saves.push(value) };
  const job = { task_id: "TICKET-A", review_policy: { gate: "on" }, payload: { execution_id: "EXECUTION-A", verification: artifact } };
  await beginAutomaticReview(job, null, checkpoints);
  assert.deepEqual(saves[0].review_verification, progress);
  await beginAutomaticReview({ ...job, payload: { ...job.payload, execution_id: "EXECUTION-OTHER" } }, null, checkpoints);
  assert.equal(saves[1].review_verification, undefined);
});

test("large receipt output stays losslessly readable through small existing-tool windows", async () => {
  const job = { task_id: "TICKET-1", project_id: "PROJECT-1", request_id: "REVIEW-1" };
  const evidence = createReviewExchangeEvidence(job.task_id, {});
  const base = createReviewerForgeTools({ projectRoot: "/project", job, reviewer: { agent_id: "REVIEWER" },
    fileService: { readForIndex: async () => { throw new Error("Unexpected source read."); } } });
  const tools = attachReviewExchangeTools(base, evidence, { job });
  const text = 'Unicode 🔒 output\n\t"\\\u0000'.repeat(3500);
  const receipt = { check_id: "CHECK-LARGE", status: "failed", commands: [{ stdout_redacted: text, stderr_redacted: "" }] };
  const original = structuredClone(receipt);
  const [reference] = addReviewVerificationEvidence(evidence, [receipt]);
  assert.match(reference.view_encoding, /lossless-string-chunks/);
  const lines = [];
  for (let start = 1; start <= reference.total_lines; start += 2) {
    const result = await tools.registry.read_lines.execute({ path: reference.path, start_line: start, end_line: start + 1 });
    assert.equal(result.sha256, reference.sha256); lines.push(result.stdout);
  }
  const view = JSON.parse(lines.join("\n"));
  assert.equal(view.commands[0].stdout_redacted.string_chunks.join(""), text);
  assert.deepEqual(receipt, original);
});

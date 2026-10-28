// Exercises independent Reviewer format correction, durable diagnostics and source-bound recovery across providers.
import assert from "node:assert/strict";
import test from "node:test";
import { requestReviewVerdict, redactReviewVerdictText } from "../../src/modules/supervisor/review-verdict-request.js";
import { parseReviewVerdict } from "../../src/modules/supervisor/review-verdict-contract.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";

const finding = { finding_id: "REV-1", failure: "Missing routing witness", acceptance_criterion: "Project isolation",
  evidence_refs: ["src/router.js:12"], minimum_change_scope: "Verify routed session creation" };
const valid = { verdict: "request_changes", findings: [finding], adjudications: [{ finding_id: "REV-1", decision: "refine",
  reason: "Access is repaired; routing evidence still needs verification", evidence_refs: ["src/router.js:12"] }] };
const invalid = { ...valid, adjudications: [{ ...valid.adjudications[0], finding_id: "TICKET-ROUTING-R1" }] };
const exchange = { findings: [{ finding_id: "REV-1" }] };
const parseOptions = { strict: true, paths: ["src/router.js"], findingIds: ["REV-1"] };

test("wrong IDs report exact field diagnostics and unknown/duplicate adjudications remain rejected", () => {
  for (const [value, message] of [
    [invalid, /adjudications\[0\]\.finding_id/],
    [{ ...valid, findings: [{ ...finding, finding_id: "ROUTING-R1" }] }, /findings\[0\]\.finding_id/],
    [{ ...valid, adjudications: [{ ...valid.adjudications[0], finding_id: "REV-99" }] }, /unknown/],
    [{ ...valid, adjudications: [...valid.adjudications, ...valid.adjudications] }, /duplicates/],
    [{ ...valid, adjudications: [{ ...valid.adjudications[0], reason: "" }] }, /\.reason/],
    [{ ...valid, adjudications: [{ ...valid.adjudications[0], evidence_refs: [] }] }, /\.evidence_refs/],
    [{ ...valid, adjudications: [{ ...valid.adjudications[0], decision: "approve" }] }, /\.decision/]
  ]) assert.throws(() => parseReviewVerdict(JSON.stringify(value), parseOptions), (error) => error.code === "REVIEW_VERDICT_INVALID" && message.test(error.message));
  assert.throws(() => parseReviewVerdict(JSON.stringify({ ...valid, adjudications: [] }), { ...parseOptions,
    pendingResponses: [{ finding_id: "REV-1", response_id: "RESP-1" }] }), /pending Coder response RESP-1/);
});

test("same independent Reviewer corrects malformed IDs without losing substantive findings or redoing discovery", async () => {
  for (const provider of ["codex", "claude", "openai"]) {
    const calls = [], saved = [], logs = [];
    const gateway = { execute: async (request) => {
      calls.push(request); request.onSessionReady("SESSION-REVIEW");
      return { text: JSON.stringify(calls.length === 1 ? invalid : valid) };
    } };
    const worker = createReviewWorker({ agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER", provider }) },
      codexSdkGateway: gateway, claudeSdkGateway: gateway, openaiSdkGateway: gateway, projectRoot: "/project",
      fileService: { readForIndex: async ({ path }) => ({ path, content: "Review source", size_bytes: 13, sha256: "sha256:source" }) },
      reviewFindings: { load: async () => exchange }, checkpoints: { saveReview: async (checkpoint) => { saved.push(structuredClone(checkpoint)); } },
      projectLogger: (log) => logs.push(log) });
    const result = await worker.review({ task_id: "TASK", agent_id: "CODER", correlation_id: "CORR", request_id: "REQUEST", payload: { changed_paths: ["src/router.js"] } });
    assert.equal(calls.length, 2);
    assert.deepEqual(result.findings, valid.findings);
    assert.deepEqual(result.adjudications, valid.adjudications);
    assert.equal(result.verdict, "request_changes");
    assert.match(calls[1].prompt, /adjudications\[0\]\.finding_id/);
    if (provider === "claude") { assert.equal(calls[1].resumeSessionId, "SESSION-REVIEW"); assert.deepEqual(calls[1].options.allowedTools, ["mcp__forge__lookup_schema"]); }
    else { assert.deepEqual(calls[1].options.forgeTools.definitions.map(({ name }) => name), ["lookup_schema"]); if (provider === "codex") assert.equal(calls[1].resumeThreadId, "SESSION-REVIEW"); }
    assert.equal(saved.at(-1).verdict_attempts.length, 2);
    assert.equal(saved.at(-1).verdict_attempts[0].status, "invalid");
    assert.equal(logs.filter((log) => log.event_name === "review.verdict_correction").length, 1);
    assert.equal(logs.filter((log) => log.event_name === "review.verdict").length, 1);
  }
});

test("persisted invalid response resumes correction and never infers an ID mapping or verdict", async () => {
  const attempts = [], requests = [];
  const result = await requestReviewVerdict({ prompt: "Retained same-revision review", parseOptions, exchange,
    retained: { response_text: JSON.stringify(invalid) }, onAttempt: async (value) => attempts.push(value), revalidate: async () => {},
    execute: async (prompt, correction) => { requests.push({ prompt, correction }); return { text: JSON.stringify(valid) }; } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].correction, true);
  assert.equal(attempts[0].response_text, JSON.stringify(invalid));
  assert.equal(result.verdict, "request_changes");
});

test("repeated invalid output parks after two correction requests, with the original responses retained", async () => {
  let calls = 0; const attempts = [];
  await assert.rejects(requestReviewVerdict({ prompt: "Review", parseOptions, exchange, revalidate: async () => {},
    onAttempt: async (attempt) => attempts.push(attempt), execute: async () => { calls++; return { text: JSON.stringify(invalid) }; } }), { code: "REVIEW_VERDICT_INVALID" });
  assert.equal(calls, 3);
  assert.equal(attempts.length, 3);
  assert(attempts.every((attempt) => attempt.status === "invalid" && attempt.response_text === JSON.stringify(invalid)));
});

test("source changes and provider errors cannot be converted to format retries or accepted verdicts", async () => {
  for (const code of ["REVIEW_SOURCE_MISMATCH", "CONFIGURATION_ERROR"]) {
    let calls = 0;
    await assert.rejects(requestReviewVerdict({ prompt: "Review", parseOptions, exchange, onAttempt: async () => {},
      revalidate: async () => { if (code === "REVIEW_SOURCE_MISMATCH") throw Object.assign(new Error("Source changed"), { code }); },
      execute: async () => { calls++; if (code === "CONFIGURATION_ERROR") throw Object.assign(new Error("Provider failed"), { code }); return { text: JSON.stringify(invalid) }; } }), { code });
    assert.equal(calls, 1);
  }
});

test("retained format diagnostics redact credentials and bound response size", () => {
  assert.equal(redactReviewVerdictText("Bearer test-secret-token"), "Bearer [REDACTED]");
  assert.equal(redactReviewVerdictText("x".repeat(40000)).length, 32000);
});

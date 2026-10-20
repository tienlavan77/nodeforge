// Exercises revision identity, append-only review attempts, audit replay, and non-blocking follow-up backlog.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { automaticReviewIdentity, automaticReviewPolicy, reviewDigest } from "../../src/modules/supervisor/automatic-review-identity.js";

test("a Reviewer reopening adjudication without duplicated finding prose reaches the repair event", async () => {
  const fixture = automaticReviewFixture({ review: async () => ({ verdict: "request_changes", findings: [], adjudications: [{ finding_id: "REV-1", decision: "reopen", reason: "Current evidence shows a remaining case", evidence_refs: ["backend/src/sample.js:1"] }] }) });
  const recorded = [];
  fixture.workspace.reviewFindings.recordReview = async (value) => recorded.push(value);
  const result = await fixture.service.process(await fixture.prepare());
  assert.equal(result.type, "review.request_changes");
  assert.equal(recorded[0].adjudications[0].decision, "reopen");
  assert.equal(fixture.events.at(-1).type, "review.request_changes");
});

// Requires one logical job per full identity while binding contract, policy, and file checksums separately.
test("automatic review deduplicates identity and changes jobs for contract, rules, checksums and revision", async () => {
  const fixture = automaticReviewFixture();
  const first = await fixture.prepare();
  assert.equal((await fixture.prepare()).id, first.id);
  fixture.request.ticket.acceptance_criteria.push("New criterion");
  assert.notEqual((await fixture.prepare()).id, first.id);
  const contract = await fixture.prepare();
  fixture.setRules("New review policy rules");
  assert.notEqual((await fixture.prepare()).id, contract.id);
  const policy = await fixture.prepare();
  fixture.artifact.file_checksums["backend/src/sample.js"] = "sha256:changed";
  assert.notEqual((await fixture.prepare()).id, policy.id);
  fixture.revise();
  assert.notEqual((await fixture.prepare()).id, first.id);
  assert.equal(reviewDigest({ nested: { second: 2, first: 1 } }), reviewDigest({ nested: { first: 1, second: 2 } }));
});

// Refuses policy flips and malformed source before any independent provider call.
test("gate cannot change and legacy repair limits do not constrain an active ticket", async () => {
  const fixture = automaticReviewFixture();
  await fixture.prepare();
  fixture.request.ticket.execution_policy.review_gate = "off";
  await assert.rejects(fixture.prepare(), { code: "REVIEW_POLICY_CONFLICT" });
  fixture.request.ticket.execution_policy.review_gate = "on";
  fixture.request.ticket.execution_policy.max_review_revisions = 3;
  await fixture.prepare();
  assert.throws(() => automaticReviewPolicy({ execution_policy: { review_gate: "bad" } }), { code: "REVIEW_POLICY_INVALID" });
  assert.throws(() => automaticReviewIdentity({ request: fixture.request, artifact: { ...fixture.artifact, status: "failed" }, context: {}, policy: {}, rules: "rules" }), { code: "REVIEW_EVIDENCE_MISMATCH" });
});

// Retained jobs with numeric legacy caps must coexist with uncapped reviews after API reload.
test("persisted legacy revision caps do not prevent the next repaired revision", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  await fixture.queueStore.save("agent.request", { ...job, review_policy: { ...job.review_policy, max_review_revisions: 0 } });
  fixture.revise();
  const next = await fixture.prepare();
  assert.notEqual(next.id, job.id);
  assert.equal(await fixture.service.consumeRepair(job), true);
  assert.equal(await fixture.service.consumeRepair(job), true);
});

// Reuses a decision after publish failure and process restart, preserving one stable event identity.
test("persist-before-publish recovery does not call Reviewer twice", async () => {
  let fail = true;
  const fixture = automaticReviewFixture({ publicationFailure: (event) => event.type === "review.approved" && fail });
  const job = await fixture.prepare();
  await assert.rejects(fixture.service.process(job), /transport interrupted/);
  assert.equal(fixture.calls, 1);
  fail = false;
  await fixture.restart().process(job);
  await fixture.service.process(job);
  assert.equal(fixture.calls, 1);
  const persisted = (await fixture.queueStore.list("agent.request"))[0];
  assert.equal(persisted.outcomes.length, 1);
  assert.equal(fixture.events.filter((event) => event.type === "review.approved").length, 1);
  assert.equal(fixture.events[0].event_id, persisted.outcomes[0].event_id);
});

// Keeps operational failures in history while allowing recovery on the same logical identity.
test("unavailable recovery appends an attempt without changing job identity", async () => {
  const fixture = automaticReviewFixture({ review: async (job, calls) => {
    if (calls === 1) throw Object.assign(new Error("Reviewer offline"), { code: "REVIEWER_NOT_AVAILABLE" });
    return { verdict: "approved", findings: [] };
  } });
  const job = await fixture.prepare();
  assert.equal((await fixture.service.process(job)).type, "review.unavailable");
  const retry = await fixture.service.retry(job);
  assert.equal(retry.job_key, job.job_key);
  assert.equal((await fixture.service.process(retry)).type, "review.approved");
  const persisted = (await fixture.queueStore.list("agent.request"))[0];
  assert.deepEqual(persisted.outcomes.map((outcome) => outcome.outcome_label), ["review_unavailable", "approved"]);
  assert.notEqual(persisted.outcomes[0].attempt_id, persisted.outcomes[1].attempt_id);
  assert.equal(await fixture.service.retry(persisted).then((current) => current.review_result.payload.verdict), "approved");
});

// Bounds infrastructure retries without pretending a fresh policy or revision was created.
test("operational attempt budget is finite", async () => {
  const fixture = automaticReviewFixture({ review: async () => { throw new Error("Provider crash"); } });
  let job = await fixture.prepare();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.equal((await fixture.service.process(job)).type, "review.failed");
    if (attempt < 2) job = await fixture.service.retry(job);
  }
  await assert.rejects(fixture.service.retry(job), { code: "REVIEW_RETRY_LIMIT" });
  assert.equal((await fixture.queueStore.list("agent.request"))[0].outcomes.length, 3);
});

// Coalesces simultaneous delivery within one process and prevents duplicate provider verdicts.
test("concurrent review delivery invokes one provider", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  await Promise.all([fixture.service.process(job), fixture.service.process(job), fixture.service.process(job)]);
  assert.equal(fixture.calls, 1);
});

// Rejects stale source and open retained findings at the final integration boundary.
test("cached approval cannot integrate a new artifact or a forged decision identity", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  const result = await fixture.service.process(job);
  const payload = { ...result.payload, job_key: job.job_key, decision_identity: job.decision_identity };
  await fixture.service.assertApproval(payload);
  await assert.rejects(fixture.service.assertApproval({ ...payload, decision_identity: { ...job.decision_identity, manifest_sha: "wrong" } }), { code: "REVIEW_EVIDENCE_MISMATCH" });
  fixture.revise();
  await assert.rejects(fixture.service.assertApproval(payload), { code: "REVIEW_EVIDENCE_MISMATCH" });
  assert.equal(fixture.integrations, 0);
});

// Makes soft-gate completion precede dispatch and preserves the original terminal ticket after adverse review.
test("soft review runs after completion and replay creates one follow-up backlog ticket", async () => {
  const fixture = automaticReviewFixture({ gate: "off", review: async () => ({ verdict: "request_changes", findings: [{ acceptance_criterion: "Correct result", failure: "Mismatch", severity: "major" }] }) });
  assert.equal((await fixture.complete()).status, "completed");
  assert.equal(fixture.calls, 0);
  assert(fixture.order.indexOf("task.completed") < fixture.order.indexOf("enqueue"));
  const job = (await fixture.queueStore.list("agent.request"))[0];
  await fixture.service.process(job);
  await fixture.restart().process(job);
  assert.equal((await fixture.queueStore.list("review.backlog")).length, 1);
  assert.equal((await fixture.workspace.reviewFindings.load()).findings.length, 1);
  assert(fixture.order.indexOf("findings") < fixture.order.indexOf("review.request_changes"));
  assert.equal((await fixture.workspace.executionContexts.load()).state, "terminal");
  assert.equal(fixture.integrations, 1);
  assert.equal(fixture.events.filter((event) => event.type === "task.needs_human_review").length, 0);
  await assert.rejects(fixture.service.park(job, "review_failed"), { code: "REVIEW_SOFT_PARK_FORBIDDEN" });
});

// Recovers the post-completion dispatch gap from intent without launching or reopening the Coder.
test("completion-before-enqueue crash recovers one async review", async () => {
  const fixture = automaticReviewFixture({ gate: "off" });
  const job = await fixture.prepare();
  await fixture.service.recordCompletion(job, { completion: "coder_verified" });
  const context = await fixture.workspace.executionContexts.load();
  await fixture.workspace.executionContexts.update("TICKET-1", context.version, { state: "terminal" });
  await fixture.restart().recover();
  assert.equal(fixture.events[0].type, "task.completed");
  assert.equal((await fixture.queueStore.list("agent.request"))[0].status, "queued");
  assert.equal(fixture.calls, 0);
  assert.equal(fixture.integrations, 0);
});

// Separates explicit skip from missing Reviewer and disallows silent hard-gate bypass.
test("review_skipped is explicit, audited and soft-only", async () => {
  const fixture = automaticReviewFixture({ gate: "off" });
  await fixture.complete();
  const job = (await fixture.queueStore.list("agent.request"))[0];
  await fixture.service.skip(job, "Owner deferred optional post-review");
  assert.equal(fixture.events.at(-1).type, "review.skipped");
  assert.equal((await fixture.queueStore.list("agent.request"))[0].outcomes[0].outcome_label, "review_skipped");
  const hard = automaticReviewFixture();
  await assert.rejects(hard.service.skip(await hard.prepare(), "skip"), { code: "REVIEW_SKIP_FORBIDDEN" });
});

// Audits interrupted provider execution before allowing a new attempt on the same source identity.
test("restart does not silently replay an unknown provider invocation", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  await fixture.queueStore.save("agent.request", { ...job, running_attempt: `${job.request_id}-OP-1` });
  const result = await fixture.restart().process(job);
  assert.equal(result.payload.error.code, "REVIEW_PROVIDER_OUTCOME_UNKNOWN");
  assert.equal(fixture.calls, 0);
  await fixture.service.retry(job);
  assert.equal((await fixture.service.process(job)).payload.verdict, "approved");
  assert.equal(fixture.calls, 1);
});

// Lets a completed-Coder operational resume recover unavailable review without creating another logical revision.
test("completed Coder resume retries review on the same identity", async () => {
  const fixture = automaticReviewFixture({ review: async (job, calls) => {
    if (calls === 1) throw Object.assign(new Error("Offline"), { code: "REVIEWER_NOT_AVAILABLE" });
    return { verdict: "approved", findings: [] };
  } });
  const job = await fixture.prepare();
  await fixture.service.process(job);
  fixture.request.payload.review_resume = { agent_id: "coder-1" };
  assert.equal((await fixture.prepare()).job_key, job.job_key);
  assert.equal((await fixture.service.process(job)).payload.verdict, "approved");
  assert.equal((await fixture.queueStore.list("agent.request"))[0].outcomes.length, 2);
});

// A failed finding write must never publish a successful soft review or leave Coder with an empty repair store.
test("soft review cannot publish request_changes when durable finding persistence fails", async () => {
  const fixture = automaticReviewFixture({ gate: "off", review: async () => ({ verdict: "request_changes", findings: [{ failure: "Missing coverage" }] }) });
  await fixture.complete();
  const job = (await fixture.queueStore.list("agent.request"))[0];
  fixture.workspace.reviewFindings.recordReview = async () => { throw Object.assign(new Error("Finding write failed"), { code: "FINDING_WRITE_FAILED" }); };
  const result = await fixture.service.process(job);
  assert.equal(result.type, "review.failed");
  assert.equal(result.payload.error.code, "FINDING_WRITE_FAILED");
  assert.equal(fixture.events.filter((event) => event.type === "review.request_changes").length, 0);
  assert.equal((await fixture.queueStore.list("review.backlog")).length, 0);
  assert.equal((await fixture.workspace.executionContexts.load()).state, "terminal");
});

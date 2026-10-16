// Verifies interrupted review recovery, immutable attempt audits, and fail-closed cached approval without provider RUN.
import test from "node:test";
import assert from "node:assert/strict";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";

// Audits an unknown provider outcome on restart rather than invoking the Reviewer again.
test("recovery audits interrupted inline review and parks without provider replay", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  await fixture.queueStore.save("agent.request", { ...job, running_attempt: `${job.request_id}-OP-1` });
  await fixture.restart().recover();
  assert.equal(fixture.calls, 0);
  assert.equal(fixture.integrations, 0);
  const current = (await fixture.queueStore.list("agent.request"))[0];
  assert.equal(current.outcomes[0].reason_code, "REVIEW_PROVIDER_OUTCOME_UNKNOWN");
  assert.equal(current.parking_outcomes.length, 1);
  assert(fixture.events.some((event) => event.type === "task.needs_human_review"));
});

// Preserves a fresh audit for each failed operational retry and deduplicates recovery of the same attempt.
test("parking history is append-only across retries and replay", async () => {
  const fixture = automaticReviewFixture({ review: async () => { throw new Error("Provider offline"); } });
  const job = await fixture.prepare();
  await fixture.service.process(job);
  await fixture.service.park(job, "REVIEW_FAILED");
  await fixture.service.retry(job);
  await fixture.service.process(job);
  await fixture.service.park(job, "REVIEW_FAILED");
  await fixture.restart().recover();
  const current = (await fixture.queueStore.list("agent.request"))[0];
  assert.equal(current.outcomes.length, 2);
  assert.equal(current.parking_outcomes.length, 2);
  assert.notEqual(current.parking_outcomes[0].attempt_id, current.parking_outcomes[1].attempt_id);
  assert.equal(fixture.events.filter((event) => event.type === "task.needs_human_review").length, 2);
  assert.equal(fixture.integrations, 0);
});

// Rejects changed cached source evidence at the final acceptance boundary, not only on queue delivery.
test("tampered cached approval cannot integrate or publish completion during recovery", async () => {
  const fixture = automaticReviewFixture();
  const job = await fixture.prepare();
  const result = await fixture.service.process(job);
  const current = (await fixture.queueStore.list("agent.request"))[0];
  current.review_result.basis.commit = "tampered";
  await fixture.queueStore.save("agent.request", current);
  await assert.rejects(fixture.service.assertApproval(result.payload), { code: "EXECUTION_RECONCILIATION_CONFLICT" });
  await fixture.restart().recover();
  assert.equal(fixture.integrations, 0);
  assert(!fixture.events.some((event) => event.type === "task.completed"));
});

// Recovers approved work interrupted before integration exactly once, with a separate completion event.
test("approved inline review recovers integration and completion without another provider turn", async () => {
  const fixture = automaticReviewFixture();
  await fixture.service.process(await fixture.prepare());
  await fixture.restart().recover();
  await fixture.restart().recover();
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.integrations, 1);
  assert.equal(fixture.events.filter((event) => event.type === "task.completed").length, 1);
});

// Isolates a corrupt historical job so unrelated deferred soft review still recovers.
test("one invalid cached job cannot abort recovery of another deferred review", async () => {
  const fixture = automaticReviewFixture({ gate: "off" });
  const first = await fixture.prepare();
  await fixture.queueStore.save("agent.request", { ...first, review_result: { type: "review.approved", payload: { verdict: "approved" }, basis: {} } });
  fixture.revise();
  await fixture.complete();
  const jobs = await fixture.queueStore.list("agent.request");
  await fixture.queueStore.save("agent.request", { ...jobs[1], status: "deferred" });
  await fixture.restart().recover();
  assert.equal((await fixture.queueStore.list("agent.request"))[1].status, "queued");
  assert.equal(fixture.calls, 0);
  assert.equal(fixture.integrations, 1);
});

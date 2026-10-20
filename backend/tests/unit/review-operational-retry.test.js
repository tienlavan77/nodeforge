// Exercises durable 30-second Reviewer polling, restart recovery, and Stop without rerunning Coder.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { retryOperationalReview, recoverOperationalReview } from "../../src/modules/supervisor/review-operational-retry.js";

// Repeated transport failures must keep one review identity and never consume a Coder repair or auto-approve.
test("temporary Reviewer outages retry every 30 seconds until independent approval", async () => {
  let now = 1000;
  const waits = [];
  const fixture = automaticReviewFixture({ operationalRetry: true, retryClock: () => now,
    retryWait: async ms => { waits.push(ms); now += ms; },
    review: async (_job, calls) => {
      if (calls <= 4) throw Object.assign(new Error("HTTP 502: Bad Gateway"), { status: 502 });
      return { verdict: "approved", findings: [] };
    } });
  const artifact = fixture.artifact;
  const result = await fixture.complete(async () => { throw new Error("Transport outage must not dispatch Coder"); });
  assert.equal(result.status, "completed");
  assert.equal(fixture.calls, 5);
  assert.deepEqual(waits, [30_000, 30_000, 30_000, 30_000]);
  assert.equal(fixture.integrations, 1);
  assert.deepEqual(fixture.artifact, artifact);
  assert(!fixture.events.some(event => ["task.failed", "task.needs_human_review", "review.failed"].includes(event.type)));
  const jobs = await fixture.queueStore.list("agent.request");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].outcomes.length, 5);
  assert.equal(jobs[0].running_attempt, null);
});

// Stop interrupts the pending wait and retains the last failed attempt without dispatching another provider.
test("Stop cancels a scheduled Reviewer retry and preserves the verified artifact", async () => {
  let stopped = false;
  const fixture = automaticReviewFixture({ operationalRetry: true,
    ticketStatusStore: { get: () => ({ status: stopped ? "failed" : "reviewing", details: stopped ? { reason: "TICKET_STOPPED" } : {} }) },
    retryWait: async () => { stopped = true; },
    review: async () => { throw Object.assign(new Error("HTTP 503: Service unavailable"), { status: 503 }); } });
  const artifact = fixture.artifact;
  const result = await fixture.complete();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "TICKET_STOPPED");
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.integrations, 0);
  assert.deepEqual(fixture.artifact, artifact);
  assert.equal((await fixture.queueStore.list("agent.request"))[0].operational_retry.status, "cancelled");
  assert(!fixture.events.some(event => event.type === "task.needs_human_review"));
});

// Reconstructs a due retry from persisted intent rather than resetting the delay after restart.
test("restart reuses the persisted retry deadline and source identity", async () => {
  let now = 25_000;
  let attempts = 0;
  const waits = [];
  let current = { id: "JOB-1", task_id: "TICKET-1", project_id: "PROJECT-1", payload: {},
    decision_identity: { source_revision: "rev", review_commit_sha: "commit", artifact_id: "artifact", base_sha: "base", manifest_sha: "manifest" },
    outcomes: [{ attempt_id: "OP-1" }], operational_retry: { status: "pending", available_at: 30_000, interval_ms: 30_000, error: { code: "HTTP_502" } } };
  const failed = { payload: { error: { code: "HTTP_502", retryable: true } } };
  const approved = { payload: { verdict: "approved" } };
  const result = await retryOperationalReview({ job: current, clock: () => now,
    wait: async ms => { waits.push(ms); now += ms; },
    attempt: async () => ++attempts === 1 ? failed : approved,
    retry: async () => {}, load: async () => current, save: async next => { current = next; }, locked: async action => action(),
    resolveTicketWorkspace: async () => ({ executionContexts: { load: async () => ({ source_revision: "rev", review_commit_sha: "commit", verification_artifact_id: "artifact", base_sha: "base", manifest_sha: "manifest" }) } }),
    projectLogger: () => {} });
  assert.equal(result, approved);
  assert.deepEqual(waits, [5000]);
  assert.equal(attempts, 2);
});

// A changed verified source cancels pending retries instead of silently adopting a new revision.
test("source drift prevents any new Reviewer invocation", async () => {
  let invoked = 0;
  let current = { id: "JOB", task_id: "TICKET", decision_identity: { source_revision: "original" } };
  await assert.rejects(retryOperationalReview({ job: current, attempt: async () => { invoked++; },
    load: async () => current, save: async next => { current = next; }, locked: async action => action(),
    resolveTicketWorkspace: async () => ({ executionContexts: { load: async () => ({ source_revision: "changed" }) } }) }), { code: "TICKET_STOPPED" });
  assert.equal(invoked, 0);
  assert.equal(current.operational_retry.status, "cancelled");
});

// Recovery must restore the completion loop so request_changes still reaches Coder and approval still integrates.
test("restart restores inline review orchestration from completed Coder without redispatching its SDK", async () => {
  const submitted = [];
  const source = { task_id: "TICKET-1", request_id: "REQ-1", project_id: "PROJECT-1", ticket: { id: "TICKET-1" },
    payload: { execution_id: "RUN-1", sprint_basis: { version: 1 }, resume_from: { status: "blocked" } } };
  const job = { inline_review: true, task_id: "TICKET-1", source_request: source, request_id: "REVIEW-1", outcomes: [{}],
    payload: { changed_paths: ["src/a.js"], base_commit: "base", verification: { artifact_id: "A", commit_sha: "C" } } };
  await recoverOperationalReview({ job, checkpoints: { load: async () => ({ status: "completed", agent_id: "coder", provider: "codex" }) },
    resumeReview: async request => { submitted.push(request); }, process: async () => { throw new Error("Must restore orchestration"); } });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].payload.execution_id, "RUN-1");
  assert.deepEqual(submitted[0].payload.sprint_basis, source.payload.sprint_basis);
  assert.equal(submitted[0].payload.resume_from, undefined);
  assert.equal(submitted[0].payload.review_resume.verification, job.payload.verification);
  assert.equal(submitted[0].payload.review_resume.agent_id, "coder");
  await assert.rejects(recoverOperationalReview({ job, checkpoints: { load: async () => ({ status: "blocked" }) }, resumeReview: async () => {} }), { code: "REVIEW_RETRY_CHECKPOINT_INVALID" });
});

// Cancellation is execution-bound and wakes the wait immediately instead of waiting another full polling interval.
test("Stop event aborts the wait immediately and unsubscribes the retry listener", async () => {
  let listener;
  let unsubscribed = false;
  const basis = { project_id: "P", sprint_id: "SPRINT", plan_id: "PLAN", plan_revision: 1, plan_path: "plan.json", plan_sha256: "a".repeat(64), version: 1 };
  let current = { id: "JOB", task_id: "T", project_id: "P", payload: { execution_id: "RUN", sprint_basis: basis }, outcomes: [{ attempt_id: "OP-1" }],
    decision_identity: { source_revision: "rev", review_commit_sha: "commit", artifact_id: "artifact", base_sha: "base", manifest_sha: "manifest" } };
  let calls = 0;
  await assert.rejects(retryOperationalReview({ job: current,
    ticketStatusStore: { get: () => ({ project_id: "P", status: "reviewing", details: { execution_id: "RUN", execution_basis: basis } }) },
    eventBus: { subscribe: (_scope, callback) => { listener = callback; return () => { unsubscribed = true; }; } },
    projectLogger: () => {}, locked: async action => action(), load: async () => current, save: async value => { current = value; },
    attempt: async () => { calls++; return { payload: { error: { retryable: true, code: "HTTP_502" } } }; },
    resolveTicketWorkspace: async () => ({ executionContexts: { load: async () => ({ source_revision: "rev", review_commit_sha: "commit", verification_artifact_id: "artifact", base_sha: "base", manifest_sha: "manifest" }) } }),
    wait: async (_ms, signal) => {
      listener({ type: "task.failed", task_id: "T", project_id: "OTHER", payload: { execution_id: "RUN", reason: "TICKET_STOPPED" } });
      assert.equal(signal.aborted, false);
      listener({ type: "task.failed", task_id: "T", project_id: "P", payload: { execution_id: "RUN", reason: "TICKET_STOPPED" } });
      assert.equal(signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    } }), { code: "TICKET_STOPPED" });
  assert.equal(calls, 1);
  assert.equal(current.operational_retry.status, "cancelled");
  assert.equal(unsubscribed, true);
});

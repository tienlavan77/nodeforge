// Exercises durable Reviewer scheduling while another ticket holds the claim.
// Waits retain the original report and source, never run Coder, and remain stoppable.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { selectAvailableReviewer } from "../../src/modules/supervisor/reviewer-agent-availability.js";
import { recoverOperationalReview } from "../../src/modules/supervisor/review-operational-retry.js";

test("busy Reviewer waits through multiple claim checks then reviews the same artifact once", async () => {
  let now = 1000, providerCalls = 0, available = false, checkpoint;
  const waits = [], logs = [];
  const profile = { agent_id: "leader", role: "reviewer", enabled: true, status: "working" };
  const resolver = { list: () => [profile], refresh: () => {}, resolveAvailable: () => available ? profile : undefined };
  const occupancy = { getByTask: () => null, listActive: () => available ? [] : [{ agent_id: "leader", task_id: "OTHER", claim_id: "CLAIM-OTHER", supervisor_id: "OTHER-SUP" }] };
  const current = { status: "running", details: {} };
  const f = automaticReviewFixture({ operationalRetry: true, retryClock: () => now, projectLogger: entry => logs.push(entry),
    ticketStatusStore: { get: () => current, updateStatus: (_id, status, details) => Object.assign(current, { status, details }) },
    checkpoints: { loadReview: async () => checkpoint, saveReview: async value => { checkpoint = value; }, completeReview: async (_id, value) => { checkpoint = value; } },
    retryWait: async ms => {
      waits.push(ms);
      assert.equal(current.status, "reviewing");
      assert.equal(checkpoint.status, "in_progress");
      assert.equal(checkpoint.operational_retry.error.agent_wait.agent_id, "leader");
      const [job] = await f.queueStore.list("agent.request");
      assert.equal(job.running_attempt, null);
      assert.equal(job.review_result.payload.error.not_started, true);
      assert.equal(job.payload.verification.artifact_id, artifact.artifact_id);
      assert.equal(providerCalls, 0);
      if (waits.length === 5) { available = true; profile.status = "ready"; }
      now += ms;
    },
    review: async job => {
      selectAvailableReviewer({ job, resolver, occupancy });
      providerCalls++;
      return { verdict: "approved", findings: [] };
    } });
  const artifact = structuredClone(f.artifact);
  assert.equal((await f.complete(() => assert.fail("Waiting must not dispatch Coder"))).status, "completed");
  assert.equal(providerCalls, 1);
  assert.deepEqual(waits, Array(5).fill(30_000));
  assert.deepEqual(f.artifact, artifact);
  assert.equal(f.integrations, 1);
  assert.equal(logs.filter(entry => entry.event_name === "review.agent_wait_scheduled").length, 1);
  assert(!logs.some(entry => entry.event_name === "review.automatic_failed"));
  assert.equal(f.events.filter(event => event.type === "ticket.updated" && event.payload.reason === "REVIEWER_BUSY").length, 1);
  assert(!f.events.some(event => ["review.unavailable", "task.failed", "task.needs_human_review"].includes(event.type)));
  const [job] = await f.queueStore.list("agent.request");
  assert.equal(job.operational_retry.status, "finished");
});

test("Stop during a Reviewer claim wait retains the source and prevents another review", async () => {
  let stopped = false;
  const f = automaticReviewFixture({ operationalRetry: true,
    ticketStatusStore: { get: () => ({ status: stopped ? "failed" : "reviewing", details: stopped ? { reason: "TICKET_STOPPED" } : {} }) },
    retryWait: async () => { stopped = true; },
    review: async () => { throw Object.assign(new Error("Reviewer is busy"), { code: "REVIEWER_BUSY", not_started: true, agent_wait: { agent_id: "leader" } }); } });
  const artifact = structuredClone(f.artifact);
  assert.equal((await f.complete()).reason, "TICKET_STOPPED");
  assert.equal(f.calls, 1);
  assert.equal(f.integrations, 0);
  assert.deepEqual(f.artifact, artifact);
  assert.equal((await f.queueStore.list("agent.request"))[0].operational_retry.status, "cancelled");
  assert(!f.events.some(event => event.type === "task.needs_human_review"));
});

test("restart resumes a persisted Reviewer wait without restarting the Coder SDK", async () => {
  const submitted = [];
  const f = automaticReviewFixture({ operationalRetry: true, retryWait: async () => { throw new Error("Simulated process loss"); },
    review: async () => { throw Object.assign(new Error("Reviewer is busy"), { code: "REVIEWER_BUSY", not_started: true, agent_wait: { agent_id: "leader" } }); } });
  const job = await f.prepare();
  await assert.rejects(f.service.process(job), /Simulated process loss/);
  const [saved] = await f.queueStore.list("agent.request");
  assert.equal(saved.operational_retry.status, "pending");
  assert.equal(saved.running_attempt, null);
  assert.equal(saved.payload.verification.commit_sha, f.artifact.commit_sha);
  await recoverOperationalReview({ job: saved,
    checkpoints: { load: async () => ({ status: "completed", agent_id: "coder-1", provider: "codex" }) },
    resumeReview: async request => submitted.push(request) });
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0].payload.review_resume.verification.artifact_id, f.artifact.artifact_id);
  assert.equal(submitted[0].payload.resume_from, undefined);
  assert.equal(f.calls, 1);
});

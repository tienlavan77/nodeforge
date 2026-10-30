// Verifies transport outages retain verified review evidence and resume without Coder repair or human approval.
import assert from "node:assert/strict";
import test from "node:test";
import { reviewOperationalFailure, createReviewTransportObserver } from "../../src/modules/supervisor/review/review-operational-failure.js";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";
import { reviewPhaseResume } from "../../src/modules/supervisor/review/review-revision-resume.js";
import { createSupervisorLoop } from "../../src/modules/supervisor/supervisor-loop.js";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";

for (const status of [429, 502, 503, 504]) {
  test(`HTTP ${status} parks a hard review as resumable failed, preserving artifact and findings`, async () => {
    const fixture = automaticReviewFixture({ review: async (_job, calls) => {
      if (calls === 1) throw Object.assign(new Error(`HTTP ${status}: upstream unavailable`), { status });
      return { verdict: "approved", findings: [] };
    } });
    let repairs = 0;
    const result = await fixture.complete(async () => { repairs++; throw new Error("Outage must not dispatch Coder"); });
    assert.equal(result.status, "failed");
    assert.equal(result.reason, `HTTP_${status}`);
    assert.equal(repairs, 0);
    assert.equal(fixture.integrations, 0);
    assert(!fixture.events.some(event => event.type === "task.needs_human_review"));
    const failed = fixture.events.find(event => event.type === "task.failed");
    assert.equal(failed.payload.retryable, true);
    assert.equal(failed.payload.resume_stage, "reviewer");
    const before = (await fixture.queueStore.list("agent.request"))[0];
    assert.equal(before.review_result.payload.error.status, status);
    assert.deepEqual(await fixture.workspace.reviewFindings.unresolved(), []);
    const identity = before.decision_identity;
    const artifact = fixture.artifact;
    fixture.restart();
    fixture.request.payload.review_resume = reviewPhaseResume({ status: "completed", agent_id: "coder-1", provider: "codex" }, { status: "failed", verdict: null });
    assert.equal((await fixture.complete()).status, "completed");
    const after = (await fixture.queueStore.list("agent.request"))[0];
    assert.deepEqual(after.decision_identity, identity);
    assert.deepEqual(fixture.artifact, artifact);
    assert.equal(after.outcomes.length, 2);
    assert.equal(fixture.integrations, 1);
    assert.equal(fixture.calls, 2);
  });
}

test("denials, forbidden access, unknown provider outcomes and code failures keep their existing boundaries", () => {
  for (const error of [
    { code: "PATH_FORBIDDEN", status: 502 },
    { code: "PROVIDER_UNKNOWN", message: "HTTP 502" },
    { code: "COMMIT_APPROVAL_REJECTED", message: "HTTP 503" },
    { message: "HTTP 502: rejected due to unacceptable risk" },
    { status: 401 }, { status: 403 }, { code: "REVIEW_EVIDENCE_STALE" },
    { message: "a source file contains 502 records" }
  ]) assert.equal(reviewOperationalFailure(error), null);
  assert.equal(reviewOperationalFailure({ code: "ECONNRESET", message: "Connection reset" }).code, "ECONNRESET");
});

test("SDK transport failures reject an apparent verdict before recording code findings", async () => {
  const observer = createReviewTransportObserver();
  observer.observe({ item: { type: "agent_message", text: "HTTP 502" } });
  observer.assertAvailable();
  observer.observe({ item: { type: "mcp_tool_call", status: "completed", error: { message: "HTTP 502" } } });
  observer.assertAvailable();
  observer.observe({ item: { type: "mcp_tool_call", status: "failed", error: { message: "HTTP 502: Bad Gateway" } } });
  assert.throws(observer.assertAvailable, error => error.retryable && error.status === 502);
  const saved = [];
  const worker = createReviewWorker({
    agentResolver: { resolveAvailable: () => ({ agent_id: "reviewer-1", provider: "codex", role: "reviewer" }) },
    codexSdkGateway: { execute: async ({ onEvent }) => {
      onEvent({ type: "item.completed", item: { type: "mcp_tool_call", status: "failed", error: { message: "HTTP 502: Bad Gateway" } } });
      return { text: JSON.stringify({ verdict: "request_changes", findings: [{ failure: "Cannot read source", severity: "major" }] }) };
    } },
    fileService: { readForIndex: async ({ path }) => ({ path, sha256: "sha256:abc", size_bytes: 10, content: "source" }) },
    projectRoot: "/project", checkpoints: { saveReview: async value => { saved.push(value); } }
  });
  await assert.rejects(worker.review({ task_id: "TICKET-1", agent_id: "coder-1", payload: { changed_paths: ["src/a.js"] } }), error => error.retryable && error.status === 502);
  assert.equal(saved.at(-1).status, "failed");
  assert.equal(saved.at(-1).last_error.code, "HTTP_502");
});

// Explicit Resume remains available after repeated transport failures without resetting findings or granting acceptance.
test("repeated 502 outages remain resumable after the ordinary operational budget", async () => {
  const fixture = automaticReviewFixture({ review: async (_job, calls) => {
    if (calls <= 4) throw Object.assign(new Error("HTTP 502: Bad Gateway"), { status: 502 });
    return { verdict: "approved", findings: [] };
  } });
  for (let attempt = 0; attempt < 4; attempt++) {
    assert.equal((await fixture.complete()).status, "failed");
    fixture.restart();
    fixture.request.payload.review_resume = { agent_id: "coder-1", provider: "codex" };
  }
  assert.equal((await fixture.complete()).status, "completed");
  assert.equal(fixture.calls, 5);
  assert.equal(fixture.integrations, 1);
  assert(!fixture.events.some(event => event.type === "task.needs_human_review"));
});

// Queued review failures use the same resumable status as inline completion, rather than escalating to Owner.
test("queued review transport failure moves Supervisor to FAILED without dispatching repair", async () => {
  const fixture = automaticReviewFixture({ review: async () => { throw Object.assign(new Error("HTTP 502: Bad Gateway"), { status: 502 }); } });
  const job = await fixture.prepare(false);
  await fixture.service.process(job);
  const transitions = [];
  const loop = createSupervisorLoop({ runtime: { taskId: "TICKET-1", supervisorId: "SUP-1", getState: () => "REVIEWING",
    transition: async state => { transitions.push(state); } }, eventBus: fixture.eventBus, automaticReview: fixture.service });
  const outcome = await loop.onEvent(fixture.events.find(event => event.type === "review.failed"));
  assert.equal(outcome.retryable, true);
  assert.deepEqual(transitions, ["FAILED"]);
  assert(!fixture.events.some(event => event.type === "task.needs_human_review"));
  assert.equal(fixture.integrations, 0);
});

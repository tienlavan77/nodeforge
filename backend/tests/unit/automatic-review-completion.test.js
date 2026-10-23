// Verifies the minimum Coder-to-Reviewer repair flow and hard/soft error gates before ticket integration.
import assert from "node:assert/strict";
import test from "node:test";
import { automaticReviewFixture } from "../fixtures/automatic-review-fixture.js";

// Exercises Coder report, request_changes, repaired revision, independent approval, and exactly one integration.
test("hard gate completes report → review → repair revision → approval → integrate", async () => {
  const fixture = automaticReviewFixture({ review: async (job, calls) => calls === 1
    ? { verdict: "request_changes", findings: [{ acceptance_criterion: "Correct result", failure: "Mismatch", severity: "major" }] }
    : { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed" }] } });
  const result = await fixture.complete(async ({ request, findings }) => {
    assert.equal(fixture.integrations, 0);
    assert.equal(findings[0].finding_id, "REV-1");
    fixture.revise();
    return { request: { ...request, attempt: 2, request_id: "REQ-REPAIR" }, result: { summary: "Fixed", tool_events: [{ name: "report_done", status: "success" }] } };
  });
  assert.equal(result.status, "completed");
  assert.equal(fixture.calls, 2);
  assert.equal(fixture.integrations, 1);
  const jobs = await fixture.queueStore.list("agent.request");
  assert.equal(jobs.length, 2);
  assert.notEqual(jobs[0].job_key, jobs[1].job_key);
  assert.equal(jobs[0].repair_consumed, true);
  assert(fixture.order.indexOf("review.approved") < fixture.order.indexOf("integrate"));
  assert(fixture.order.includes("approved_report_completed"));
  assert.equal(fixture.events.at(-1).payload.completion, "reviewed");
});

// Legacy zero/one revision budgets must not stop progressing repairs before independent approval.
for (const limit of [0, 1]) {
  test(`repair continues past legacy limit ${limit} until independent approval`, async () => {
    const fixture = automaticReviewFixture({ limit, review: async (job, calls) => calls <= 4
      ? { verdict: "request_changes", findings: [{ failure: `Remaining issue ${calls}`, severity: "major" }] }
      : { verdict: "approved", findings: [], adjudications: [1, 2, 3, 4].map((id) => ({ finding_id: `REV-${id}`, decision: "fixed" })) } });
    let repairs = 0;
    const result = await fixture.complete(async ({ request }) => {
      repairs += 1;
      fixture.revise();
      return { request: { ...request, attempt: request.attempt + 1 }, result: { summary: "Repaired", tool_events: [{ name: "report_done", status: "success" }] } };
    });
    assert.equal(result.status, "completed");
    assert.equal(repairs, 4);
    assert.equal(fixture.calls, 5);
    assert.equal(fixture.integrations, 1);
    assert(!fixture.events.some((event) => event.type === "review.revision_limit"));
  });
}

// Parks unavailable, provider failures, alias verdicts, blocked responses, and stale revisions without auto-approval.
for (const [label, review] of [
  ["unavailable", async () => { throw Object.assign(new Error("Offline"), { code: "REVIEWER_NOT_AVAILABLE" }); }],
  ["provider crash", async () => { throw new Error("Provider failed"); }],
  ["invalid alias", async () => ({ verdict: "approve", findings: [] })],
  ["blocked", async () => ({ verdict: "blocked", findings: [] })],
  ["stale revision", async () => ({ verdict: "approved", source_revision: 0, findings: [] })],
  ["same Coder", async () => ({ verdict: "approved", reviewer_id: "coder-1", findings: [] })]
]) {
  test(`hard gate ${label} does not integrate or fail the ticket`, async () => {
    const fixture = automaticReviewFixture({ review });
    assert.equal((await fixture.complete()).status, "needs_human_review");
    assert.equal(fixture.integrations, 0);
    assert(!fixture.events.some((event) => ["review.approved", "task.failed", "task.completed"].includes(event.type)));
  });
  test(`soft gate ${label} keeps original completion immutable`, async () => {
    const fixture = automaticReviewFixture({ gate: "off", review });
    assert.equal((await fixture.complete()).status, "completed");
    await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
    assert.equal(fixture.integrations, 1);
    assert.equal((await fixture.workspace.executionContexts.load()).state, "terminal");
    assert(!fixture.events.some((event) => ["review.approved", "task.failed", "task.needs_human_review"].includes(event.type)));
  });
}

// Rejects a superficial approval while a prior blocking finding remains open.
test("Coder cannot close retained findings and Reviewer approval must adjudicate them", async () => {
  const fixture = automaticReviewFixture({ review: async (job, calls) => calls === 1 ? { verdict: "request_changes", findings: [{ failure: "Open finding", severity: "major" }] } : { verdict: "approved", findings: [] } });
  const result = await fixture.complete(async ({ request }) => { fixture.revise(); return { request, result: { summary: "Coder claims fixed", tool_events: [{ name: "report_done", status: "success" }] } }; });
  assert.equal(result.status, "needs_human_review");
  assert.equal(fixture.integrations, 0);
  assert.equal(fixture.events.find((event) => event.type === "review.failed").payload.error.code, "REVIEW_FINDINGS_UNRESOLVED");
});

// Bounds Coder retries that return the same artifact without a durable dispute response.
test("repair with no source or explanation change parks instead of looping indefinitely", async () => {
  const fixture = automaticReviewFixture({ review: async () => ({ verdict: "request_changes", findings: [{ failure: "Unchanged", severity: "major" }] }) });
  const result = await fixture.complete(async ({ request }) => ({ request, result: { summary: "No actual repair", tool_events: [{ name: "report_done", status: "success" }] } }));
  assert.equal(result.status, "needs_human_review");
  assert.equal(result.reason, "REVIEW_REPAIR_REVISION_REQUIRED");
  assert.equal(fixture.calls, 1);
  assert.equal(fixture.integrations, 0);
});

// Keeps serious defects blocked on repair and independent acceptance without treating severity as Owner authority.
test("blocker uses ordinary Coder repair, while soft review creates urgent follow-up", async () => {
  for (const gate of ["on", "off"]) {
    let repairs = 0;
    const fixture = automaticReviewFixture({ gate, review: async (_job, calls) => calls === 1
      ? { verdict: "request_changes", findings: [{ failure: "Risk of data loss", severity: "blocker" }] }
      : { verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed" }] } });
    const result = await fixture.complete(async ({ request }) => {
      repairs++;
      assert.equal(fixture.integrations, 0);
      fixture.revise();
      return { request, result: { tool_events: [{ name: "report_done", status: "success" }] } };
    });
    if (gate === "off") await fixture.service.process((await fixture.queueStore.list("agent.request"))[0]);
    assert.equal(result.status, "completed");
    assert.equal(repairs, gate === "on" ? 1 : 0);
    assert.equal(fixture.events.some((event) => event.type === "review.owner_decision_required"), false);
    assert.equal(fixture.integrations, 1);
    if (gate === "off") assert.equal((await fixture.queueStore.list("review.backlog"))[0].priority, "critical");
  }
});

// Fails closed for hard review storage failure while keeping soft infrastructure failures after completion.
test("review preparation storage failure respects both gate lifecycles", async () => {
  for (const gate of ["on", "off"]) {
    const fixture = automaticReviewFixture({ gate });
    fixture.queueStore.save = async () => { throw Object.assign(new Error("Queue storage unavailable"), { code: "REVIEW_STORAGE_UNAVAILABLE" }); };
    const result = await fixture.complete();
    assert.equal(result.status, gate === "on" ? "needs_human_review" : "completed");
    assert.equal(fixture.integrations, gate === "on" ? 0 : 1);
    assert.equal(fixture.calls, 0);
    const failure = fixture.events.find((event) => event.type === "review.failed");
    assert.equal(failure.payload.error.code, "REVIEW_STORAGE_UNAVAILABLE");
    if (gate === "off") {
      assert(fixture.order.indexOf("task.completed") < fixture.order.indexOf("review.failed"));
      assert(!fixture.events.some((event) => event.type === "task.needs_human_review"));
    }
  }
});

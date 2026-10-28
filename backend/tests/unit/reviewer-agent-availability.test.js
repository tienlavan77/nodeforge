// Verifies that independent Reviewer scheduling distinguishes durable occupancy
// from invalid configuration and refreshes profiles before retrying an atomic claim.
import assert from "node:assert/strict";
import test from "node:test";
import { selectAvailableReviewer, reviewerClaimFailure } from "../../src/modules/supervisor/reviewer-agent-availability.js";
import { reviewOperationalFailure } from "../../src/modules/supervisor/review-operational-failure.js";

/** Models shared Reviewer profiles and claims without starting providers or
 * modifying live ticket state, including claims held by another project. */
function fixture({ pinned = true } = {}) {
  const profile = { agent_id: "leader", role: "reviewer", enabled: true, status: "working" };
  const claim = { agent_id: "leader", claim_id: "CLAIM-OTHER", task_id: "OTHER", project_id: "OTHER-PROJECT", supervisor_id: "OTHER-SUP" };
  const job = { task_id: "TICKET", project_id: "PROJECT", supervisor_id: "SUP", agent_id: "coder",
    payload: { ticket: { execution_contract: pinned ? { reviewer: "leader" } : {} } } };
  let refreshes = 0;
  const resolver = { refresh: () => { refreshes++; }, list: () => [profile], resolveAvailable: () => profile.status === "ready" && profile.enabled ? profile : undefined };
  const occupancy = { getByTask: () => null, listActive: () => profile.status === "working" ? [claim] : [] };
  return { profile, claim, job, resolver, occupancy, get refreshes() { return refreshes; } };
}

for (const pinned of [true, false]) test(`busy ${pinned ? "contracted" : "pooled"} Reviewer waits without switching providers`, () => {
  const f = fixture({ pinned });
  assert.throws(() => selectAvailableReviewer(f), error => {
    assert.equal(error.code, "REVIEWER_BUSY");
    assert.equal(error.not_started, true);
    assert.equal(error.agent_wait.busy_project_id, "OTHER-PROJECT");
    assert.equal(error.agent_wait.claim_id, "CLAIM-OTHER");
    assert.equal(reviewOperationalFailure(error).retryable, true);
    return true;
  });
  f.profile.status = "ready";
  assert.equal(selectAvailableReviewer(f), f.profile);
  assert.equal(f.refreshes, 2);
});

test("missing or disabled Reviewer and conflicting ticket claims never become polling waits", () => {
  const f = fixture();
  f.profile.enabled = false;
  assert.throws(() => selectAvailableReviewer(f), { code: "REVIEWER_NOT_AVAILABLE" });
  assert.equal(reviewOperationalFailure(reviewerClaimFailure({ ...f, profile: f.profile })), null);
  f.resolver.list = () => [];
  assert.throws(() => selectAvailableReviewer(f), { code: "REVIEWER_NOT_AVAILABLE" });
  f.profile.enabled = true;
  f.resolver.list = () => [f.profile];
  f.occupancy.getByTask = () => ({ agent_id: "different-reviewer" });
  assert.throws(() => selectAvailableReviewer(f), { code: "REVIEWER_NOT_AVAILABLE" });
  assert.equal(reviewOperationalFailure({ code: "REVIEWER_BUSY", message: "Unproven provider outcome" }), null);
});

test("an atomic claim race is retryable before any provider starts, while own claims can resume", () => {
  const f = fixture();
  f.profile.status = "ready";
  const error = reviewerClaimFailure({ ...f, profile: f.profile });
  assert.equal(error.code, "REVIEWER_BUSY");
  assert.equal(error.not_started, true);
  assert.equal(reviewOperationalFailure(error).retryable, true);
  Object.assign(f.claim, { task_id: f.job.task_id, supervisor_id: f.job.supervisor_id, project_id: f.job.project_id });
  f.profile.status = "working";
  f.occupancy.getByTask = () => f.claim;
  assert.equal(selectAvailableReviewer(f), f.profile);
});

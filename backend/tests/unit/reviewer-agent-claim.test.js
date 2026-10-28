// Verifies the production review resolver's atomic scheduling boundary so two
// tickets cannot start the same Reviewer and claim races remain safe to retry.
import assert from "node:assert/strict";
import test from "node:test";
import { createAutomaticReviewWorkerResolver } from "../../src/modules/supervisor/automatic-review-source.js";

/** Provides a minimal production resolver with an in-memory atomic occupancy
 * store; no source is read and no real provider or live claim is created. */
function fixture() {
  const profile = { agent_id: "leader", role: "reviewer", provider: "codex", enabled: true, status: "ready" };
  let active, claims = 0, providerCalls = 0;
  const resolver = { refresh: () => {}, list: () => [profile], resolveAvailable: () => profile.status === "ready" ? profile : undefined };
  const occupancy = { listActive: () => active ? [active] : [], getByTask: id => active?.task_id === id ? active : null,
    claim: async input => {
      if (active) return null;
      claims++;
      active = { agent_id: input.agentId, task_id: input.taskId, supervisor_id: input.supervisorId, project_id: input.projectId, claim_id: `CLAIM-${claims}` };
      profile.status = "working";
      return active;
    } };
  const resolve = createAutomaticReviewWorkerResolver({ agentResolver: resolver, agentOccupancy: occupancy,
    resolveTicketWorkspace: async () => ({ path: "/project", worktreeFileService: { readForIndex: async () => ({ content: "source" }) } }),
    gateways: { codexSdkGateway: { execute: async () => { providerCalls++; } } } });
  const job = { task_id: "TICKET-A", project_id: "PROJECT-A", supervisor_id: "SUP-A", agent_id: "coder",
    review_policy: { gate: "on" }, payload: { ticket: { execution_contract: { reviewer: "leader" } } } };
  return { profile, occupancy, resolve, job, get claims() { return claims; }, get providerCalls() { return providerCalls; },
    release: () => { active = null; profile.status = "ready"; } };
}

test("two production review jobs acquire the shared Reviewer sequentially across projects", async () => {
  const f = fixture();
  const second = { ...f.job, task_id: "TICKET-B", project_id: "PROJECT-B", supervisor_id: "SUP-B" };
  const results = await Promise.allSettled([f.resolve(f.job), f.resolve(second)]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const waiting = results.find(result => result.status === "rejected");
  assert.equal(waiting.reason.code, "REVIEWER_BUSY");
  assert.equal(waiting.reason.not_started, true);
  assert.equal(waiting.reason.agent_wait.busy_task_id, "TICKET-A");
  assert.equal(f.claims, 1);
  assert.equal(f.providerCalls, 0);
  f.release();
  assert.equal(typeof (await f.resolve(second)).review, "function");
  assert.equal(f.claims, 2);
  assert.equal(f.occupancy.listActive()[0].task_id, "TICKET-B");
});

test("a lost atomic claim race queues review without invoking its SDK", async () => {
  const f = fixture();
  f.occupancy.claim = async () => null;
  await assert.rejects(f.resolve(f.job), error => error.code === "REVIEWER_BUSY" && error.not_started === true);
  assert.equal(f.providerCalls, 0);
});

test("a Reviewer disabled during claim remains a configuration failure rather than an endless wait", async () => {
  const f = fixture();
  f.occupancy.claim = async () => { f.profile.enabled = false; return null; };
  await assert.rejects(f.resolve(f.job), { code: "REVIEWER_NOT_AVAILABLE" });
  assert.equal(f.providerCalls, 0);
});

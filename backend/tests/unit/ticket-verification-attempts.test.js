// Verifies durable retry order ignores random verification job ID order.
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestTicketVerificationAttempt } from "../../src/modules/supervisor/ticket-verification-attempts.js";

// Chooses the actual second attempt when its UUID sorts before the first.
test("latest verification attempt uses persisted attempt rather than UUID order", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-attempts-"));
  try {
    await mkdir(join(root, ".forge/runtime/ticket-verification/TICKET-1/jobs"), { recursive: true });
    const jobs = {
      "VERIFY-zzz": { job_id: "VERIFY-zzz", attempt: 1, status: "failed", commit_sha: "COMMIT", source_revision: "REV", policy_version: "ticket-verification-v5", started_at: "2026-10-05T00:00:00Z" },
      "VERIFY-aaa": { job_id: "VERIFY-aaa", attempt: 2, status: "failed", commit_sha: "COMMIT", source_revision: "REV", policy_version: "ticket-verification-v5", started_at: "2026-10-05T00:01:00Z" },
      "VERIFY-old": { job_id: "VERIFY-old", attempt: 8, status: "failed", commit_sha: "COMMIT", source_revision: "REV", policy_version: "ticket-verification-v4", started_at: "2026-10-05T00:02:00Z" }
    };
    await Promise.all(Object.entries(jobs).map(([id, job]) => writeFile(join(root, ".forge/runtime/ticket-verification/TICKET-1/jobs", `${id}.json`), JSON.stringify(job))));
    const latest = await latestTicketVerificationAttempt({ projectRoot: root, taskId: "TICKET-1", context: { review_commit_sha: "COMMIT", source_revision: "REV" }, policyVersion: "ticket-verification-v5", loadJob: async (id) => jobs[id] });
    assert.equal(latest.job_id, "VERIFY-aaa");
    assert.equal(latest.attempt, 2);
    const options = { projectRoot: root, taskId: "TICKET-1", context: { review_commit_sha: "COMMIT", source_revision: "REV" }, policyVersion: "ticket-verification-v5", runnerRevision: "runner-repaired", loadJob: async (id) => jobs[id] };
    assert.equal(await latestTicketVerificationAttempt(options), null);
    jobs["VERIFY-repaired"] = { ...jobs["VERIFY-aaa"], job_id: "VERIFY-repaired", attempt: 1, runner_revision: "runner-repaired" };
    await writeFile(join(root, ".forge/runtime/ticket-verification/TICKET-1/jobs/VERIFY-repaired.json"), JSON.stringify(jobs["VERIFY-repaired"]));
    assert.equal((await latestTicketVerificationAttempt(options)).attempt, 1);
    jobs["VERIFY-repaired-second"] = { ...jobs["VERIFY-repaired"], job_id: "VERIFY-repaired-second", attempt: 2 };
    await writeFile(join(root, ".forge/runtime/ticket-verification/TICKET-1/jobs/VERIFY-repaired-second.json"), JSON.stringify(jobs["VERIFY-repaired-second"]));
    assert.equal((await latestTicketVerificationAttempt(options)).attempt, 2);
    jobs["VERIFY-repaired"].started_at = "2026-10-05T00:05:00Z";
    const diagnostic = await latestTicketVerificationAttempt({ ...options, matchRunnerRevision: false });
    assert.equal(diagnostic.job_id, "VERIFY-repaired"); assert.equal(diagnostic.attempt, 1);
    assert.equal(await latestTicketVerificationAttempt({ ...options, runnerRevision: "runner-next-repair" }), null);
    assert.equal(await latestTicketVerificationAttempt({ ...options, context: { ...options.context, review_commit_sha: "OTHER" } }), null);
    assert.equal(await latestTicketVerificationAttempt({ ...options, context: { ...options.context, source_revision: "OTHER" } }), null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

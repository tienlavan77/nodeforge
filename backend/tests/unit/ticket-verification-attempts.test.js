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
  } finally { await rm(root, { recursive: true, force: true }); }
});

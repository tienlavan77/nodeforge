// Finds the latest durable verification attempt for one ticket commit and source revision.
import { readdir } from "node:fs/promises";
import { join } from "node:path";

// Uses persisted attempt and time instead of random job IDs to enforce the retry limit.
export async function latestTicketVerificationAttempt({ projectRoot, taskId, context, policyVersion, loadJob }) {
  let names;
  try { names = await readdir(join(projectRoot, ".forge/runtime/ticket-verification", taskId, "jobs")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const jobs = (await Promise.all(names.filter((name) => /^VERIFY-[A-Za-z0-9-]+\.json$/.test(name))
    .map((name) => loadJob(name.slice(0, -5)))))
    .filter((job) => job?.commit_sha === context.review_commit_sha && job.source_revision === context.source_revision && (!policyVersion || job.policy_version === policyVersion));
  if (!jobs.length) return null;
  const latest = jobs.sort((left, right) =>
    (Number(right.attempt) || 1) - (Number(left.attempt) || 1)
    || String(right.started_at ?? "").localeCompare(String(left.started_at ?? ""))
    || String(right.job_id).localeCompare(String(left.job_id)))[0];
  return { ...latest, attempt: Math.max(jobs.length, ...jobs.map((job) => Number(job.attempt) || 1)) };
}

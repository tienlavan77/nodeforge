// Prevents Supervisor verification pass events without evidence for the committed ticket revision.

// Checks a ticket artifact against the collected manifest before forwarding a pass event.
export async function verifyTicketChangeset({ workspace, job, legacyWorker }) {
  if (!workspace) return legacyWorker.verifyChangeset(job.payload ?? job);
  try {
    const artifact = await workspace.testService.assertPassedArtifact();
    const collected = job.payload ?? job;
    const expected = Object.keys(artifact.file_checksums).sort();
    const actual = [...(collected.changed_paths ?? [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected) || actual.some((path) => collected.checksums?.[path] !== artifact.file_checksums[path])) throw Object.assign(new Error("Collected changes do not match the passed ticket artifact."), { code: "VERIFY_COLLECTOR_MISMATCH" });
    return { ...collected, status: "passed", verification_artifact_id: artifact.artifact_id, commit_sha: artifact.commit_sha, passed_paths: expected.map((path) => ({ path, checksum: artifact.file_checksums[path], verification: { passed: true } })), failed_paths: [] };
  } catch (error) {
    return { ...(job.payload ?? job), status: "failed", error: { code: error.code ?? "VERIFY_ARTIFACT_MISMATCH", message: error.message }, passed_paths: [], failed_paths: (job.payload?.changed_paths ?? job.changed_paths ?? []).map((path) => ({ path, verification: { passed: false } })) };
  }
}

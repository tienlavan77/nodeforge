// Verifier: checks the collected change-set on the real filesystem. Node stays
// the source of truth for PASS/FAIL. Publish contract (verification.passed /
// verification.failed) is unchanged.
export function createVerificationWorker({ verify = async () => ({ passed: true }) } = {}) {
  return Object.freeze({ verifyChangeset, verifyPatches });
  async function verifyChangeset(input = {}) {
    const changedPaths = input.changed_paths ?? [];
    const results = [];
    for (const path of changedPaths) {
      const result = await verify({ path, checksum: input.checksums?.[path] ?? null });
      results.push({ path, checksum: input.checksums?.[path] ?? null, verification: result });
    }
    const failed = results.filter((item) => item.verification?.passed === false);
    return { ...input, passed_paths: results.filter((item) => item.verification?.passed !== false), failed_paths: failed, status: failed.length ? "failed" : "passed" };
  }
  // Legacy shape kept one release for queued jobs created by the old pipeline.
  async function verifyPatches(input = {}) {
    const passed = []; const failed = [];
    for (const patch of input.valid_patches ?? []) {
      const result = await verify(patch);
      (result?.passed ? passed : failed).push({ ...patch, verification: result });
    }
    return { ...input, passed_patches: passed, failed_patches: failed, status: failed.length ? "failed" : "passed" };
  }
}

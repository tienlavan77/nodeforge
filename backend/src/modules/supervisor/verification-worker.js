export function createVerificationWorker({ verify = async () => ({ passed: true }) } = {}) {
  return Object.freeze({ verifyPatches });
  async function verifyPatches(input = {}) {
    const passed = []; const failed = [];
    for (const patch of input.valid_patches ?? []) {
      const result = await verify(patch);
      (result?.passed ? passed : failed).push({ ...patch, verification: result });
    }
    return { ...input, passed_patches: passed, failed_patches: failed, status: failed.length ? "failed" : "passed" };
  }
}

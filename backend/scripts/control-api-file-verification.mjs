export function isTestSourcePath(path) {
  return /^(?:tests|backend\/tests|ui\/tests|ui\/nextjs\/tests)(\/|$)/.test(path);
}

export function createOnWriteVerifier({ getTestService } = {}) {
  return async function verifyWrite({ path }) {
    const testService = getTestService();
    if (!testService || !isTestSourcePath(path)) return undefined;
    const result = await testService.runTests({ commitId: `FILE-${path}-${Date.now()}`, levels: ["unit_test"], taskId: path });
    if (result.status !== "passed" || result.ready_for_review !== true) {
      const error = new Error(`Verification failed for ${path}: ${result.status}`);
      error.verificationResult = result;
      throw error;
    }
    return result;
  };
}

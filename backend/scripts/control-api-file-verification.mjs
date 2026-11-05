export function isTestSourcePath(path) {
  return typeof path === "string" && /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(path)
    || typeof path === "string" && /(?:\.test|\.spec)\.[A-Za-z0-9]+$/i.test(path);
}

// Selects a safe focused command for a newly written project test file.
// Business purpose: lets admitted projects verify their own PHP and JavaScript tests instead of limiting automatic checks to NodeForge's backend test directories.
// Technical description: returns project-relative `php -l` for PHP sources and `node --test` for supported JavaScript or TypeScript test filenames, while rejecting absolute and traversal paths.
export function testCommandForPath(path) {
  if (typeof path !== "string" || !path || /(^|\/|\s)\.\.(?:\/|$)/.test(path) || /(^|\s)(?:\/|[A-Za-z]:\\)/.test(path)) return undefined;
  if (/\.php$/i.test(path)) return `php -l ${path}`;
  if (/(?:\.test|\.spec)\.(?:c|m)?jsx?$|(?:\.test|\.spec)\.(?:c|m)?tsx?$/i.test(path)) return `node --test ${path}`;
  return undefined;
}

export function createOnWriteVerifier({ getTestService } = {}) {
  return async function verifyWrite({ path }) {
    const testService = getTestService();
    if (!testService || !isTestSourcePath(path)) return undefined;
    const command = testCommandForPath(path);
    if (!command) return undefined;
    const result = await testService.runTests({ commitId: `FILE-${path}-${Date.now()}`, levels: ["unit_test"], taskId: path, command });
    if (result.status !== "passed" || result.ready_for_review !== true) {
      const error = new Error(`Verification failed for ${path}: ${result.status}`);
      error.verificationResult = result;
      throw error;
    }
    return result;
  };
}

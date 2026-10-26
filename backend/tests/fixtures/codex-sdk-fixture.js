// Isolates stubbed Codex agents from real SDK homes when tests run from either
// repository root or backend. Each gateway receives a disposable project-local
// home, while tests that explicitly supply a home retain their chosen fixture.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after } from "node:test";
import { createCodexSdkGateway } from "../../src/modules/agent/codex-sdk-gateway.js";
import { REPOSITORY_ROOT } from "../../src/shared/repository-root.js";

// Prevents gateway tests from creating fake agent directories in production
// runtime storage and registers cleanup even when an SDK assertion fails.
export function createTestCodexSdkGateway(options) {
  if (options.codexHomeRoot) return createCodexSdkGateway(options);
  const scratch = join(REPOSITORY_ROOT, ".forge/scratch");
  mkdirSync(scratch, { recursive: true });
  const codexHomeRoot = mkdtempSync(join(scratch, "codex-sdk-test-"));
  after(() => rmSync(codexHomeRoot, { recursive: true, force: true }));
  return createCodexSdkGateway({ ...options, codexHomeRoot });
}

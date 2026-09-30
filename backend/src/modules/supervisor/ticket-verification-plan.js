// Selects the complete immutable checks required to accept a ticket commit.
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

// Requires schema validation for backend, schema, and API client contract changes.
export function requiresSchemaVerification(paths) {
  return paths.some((path) => path.startsWith("backend/") || path.startsWith("schemas/") || /^ui\/nextjs\/lib\/(?:node-client|project-stream-client|error-normalizer)/.test(path));
}

// Builds a reproducible command list against the committed source archive.
export async function buildTicketVerificationPlan(paths, root) {
  const checks = [];
  const backend = paths.some((path) => path.startsWith("backend/"));
  if (backend) {
    checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
    const lintPaths = paths.filter((path) => /^backend\/.*\.[cm]?js$/.test(path));
    if (lintPaths.length) checks.push({ kind: "lint", argv: [process.execPath, "node_modules/eslint/bin/eslint.js", "--rulesdir", "eslint-rules", "--no-ignore", "--max-warnings=0", ...lintPaths] });
  }
  if (requiresSchemaVerification(paths)) checks.push({ kind: "schema_validation", argv: [process.execPath, "backend/scripts/validate-schemas.mjs"] });
  if (backend) {
    const tests = (await readdir(join(root, "backend/tests"), { recursive: true }))
      .filter((path) => /\.test\.[cm]?js$/.test(path)).sort().map((path) => `backend/tests/${path}`);
    if (!tests.length) throw Object.assign(new ConfigurationError("Backend verification has no tests to run."), { code: "VERIFY_PLAN_EMPTY" });
    checks.push({ kind: "backend_tests", argv: [process.execPath, "--test", ...tests] });
  }
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) {
    const entries = await readdir(join(root, "ui/nextjs/tests"), { withFileTypes: true });
    const tests = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".test.js")).map((entry) => `ui/nextjs/tests/${entry.name}`);
    if (tests.length) checks.push({ kind: "test", argv: [process.execPath, "--test", ...tests] });
    checks.push({ kind: "build", argv: [process.execPath, "ui/nextjs/node_modules/next/dist/bin/next", "build", "ui/nextjs", "--webpack"] });
  }
  if (!checks.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
  return checks;
}

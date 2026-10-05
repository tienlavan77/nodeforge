// Selects the complete immutable checks required to accept a ticket commit.
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";

// Requires schema validation for backend, schema, and API client contract changes.
export function requiresSchemaVerification(paths) {
  return paths.some((path) => path.startsWith("backend/") || path.startsWith("schemas/") || /^ui\/nextjs\/lib\/(?:node-client|project-stream-client|error-normalizer)/.test(path));
}

// Builds a reproducible command list against the committed source archive.
export async function buildTicketVerificationPlan(paths, root, { fullBackend = false, verificationPlan = [] } = {}) {
  const checks = [];
  const backend = paths.some((path) => path.startsWith("backend/"));
  if (backend) {
    checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
    const lintPaths = paths.filter((path) => /^backend\/.*\.[cm]?js$/.test(path));
    if (lintPaths.length) checks.push({ kind: "lint", argv: [process.execPath, "node_modules/eslint/bin/eslint.js", "--rulesdir", "eslint-rules", "--no-ignore", "--max-warnings=0", ...lintPaths] });
  }
  if (requiresSchemaVerification(paths)) checks.push({ kind: "schema_validation", argv: [process.execPath, "backend/scripts/validate-schemas.mjs"] });
  if (backend) {
    const allTests = (await readdir(join(root, "backend/tests"), { recursive: true }))
      .filter((path) => /\.test\.[cm]?js$/.test(path)).sort().map((path) => `backend/tests/${path}`);
    const tests = fullBackend ? allTests : await selectRelatedTests(paths, allTests, root);
    if (!tests.length) throw Object.assign(new ConfigurationError("No backend test covers the ticket paths; add or identify a ticket test before verification."), { code: "VERIFY_TEST_SCOPE_EMPTY" });
    checks.push({ kind: "backend_tests", argv: [process.execPath, "--test", ...tests] });
  }
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) {
    const entries = await readdir(join(root, "ui/nextjs/tests"), { withFileTypes: true });
    const available = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".test.js")).map((entry) => `ui/nextjs/tests/${entry.name}`);
    const tests = await selectRelatedTests(paths, available, root, "ui/nextjs/");
    if (tests.length) checks.push({ kind: "test", argv: [process.execPath, "--test", ...tests] });
    checks.push({ kind: "build", argv: [process.execPath, "ui/nextjs/node_modules/next/dist/bin/next", "build", "ui/nextjs", "--webpack"] });
  }
  for (const step of verificationPlan) {
    if (step?.kind !== "test" || typeof step.test_path !== "string" || commandsContainTest(checks, step.test_path)) continue;
    if (!/^(?:backend\/tests|ui\/nextjs\/tests)\/.+\.test\.[cm]?[jt]sx?$/.test(step.test_path)) throw new ConfigurationError(`Verification test path is outside supported test directories: ${step.test_path}`);
    checks.push({ kind: "test", argv: [process.execPath, "--test", step.test_path] });
  }
  if (!checks.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
  return checks;
}

// Avoids running a focused test twice when source-based selection already chose it.
function commandsContainTest(checks, path) { return checks.some((check) => check.kind === "test" && check.argv?.includes(path)); }

// Selects ticket tests and direct source importers so unrelated backend suites do not delay review.
async function selectRelatedTests(paths, tests, root, sourcePrefix = "backend/src/") {
  const changedTests = new Set(paths.filter((path) => tests.includes(path)));
  const sourcePaths = paths.filter((path) => path.startsWith(sourcePrefix) && !path.includes("/tests/") && /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/.test(path));
  if (!sourcePaths.length) return [...changedTests].sort();
  for (const test of tests) {
    if (changedTests.has(test)) continue;
    const name = basename(test).replace(/\.test\.[cm]?js$/, "");
    if (sourcePaths.some((path) => basename(path).replace(/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/, "") === name)) { changedTests.add(test); continue; }
    const imports = sourcePaths.map((path) => {
      const value = relative(dirname(join(root, test)), join(root, path));
      return value.startsWith(".") ? value : `./${value}`;
    });
    const content = await readFile(join(root, test), "utf8");
    if (imports.some((value) => content.includes(`"${value}"`) || content.includes(`'${value}'`))) changedTests.add(test);
  }
  return [...changedTests].sort();
}

// Selects the complete immutable checks required to accept a ticket commit.
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { ConfigurationError } from "../../shared/errors.js";
import { fileURLToPath } from "node:url";
import { assertCodingBrowserStep } from "./browser-coding-contract.js";

// Requires schema validation for backend, schema, and API client contract changes.
export function requiresSchemaVerification(paths) {
  return paths.some((path) => path.startsWith("backend/") || path.startsWith("schemas/") || /^ui\/nextjs\/lib\/(?:node-client|project-stream-client|error-normalizer)/.test(path));
}

// Builds a reproducible command list against the committed source archive.
export async function buildTicketVerificationPlan(paths, root, { fullBackend = false, verificationPlan = [] } = {}) {
  const checks = [];
  const backend = paths.some((path) => path.startsWith("backend/"));
  if (backend) {
    const sources = [];
    for (const path of paths.filter((path) => /^backend\/.*\.[cm]?[jt]sx?$/.test(path))) {
      try { if ((await stat(join(root, path))).isFile()) sources.push(path); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    if (sources.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--allowJs", "--checkJs", "false", "--noEmit", "--target", "ES2023", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--skipLibCheck", ...sources] });
    const lintPaths = sources.filter((path) => /\.[cm]?js$/.test(path));
    if (lintPaths.length) checks.push({ kind: "lint", argv: [process.execPath, "node_modules/eslint/bin/eslint.js", "--rulesdir", "eslint-rules", "--no-ignore", "--max-warnings=0", ...lintPaths] });
  }
  if (requiresSchemaVerification(paths)) checks.push({ kind: "schema_validation", scope: verificationPlan.some((step) => step?.kind === "schema_validation") || paths.some((path) => path.startsWith("schemas/") || path === "backend/scripts/validate-schemas.mjs") ? "ticket" : "regression", reason: "Shared schema contract validation after backend or API changes", argv: [process.execPath, "backend/scripts/validate-schemas.mjs"] });
  if (backend) {
    const allTests = (await readdir(join(root, "backend/tests"), { recursive: true }))
      .filter((path) => /\.test\.[cm]?js$/.test(path)).sort().map((path) => `backend/tests/${path}`);
    const related = selectNamedTests(paths, allTests);
    const mapped = verificationPlan.filter((step) => step?.kind === "test" && allTests.includes(step.test_path)).map((step) => step.test_path);
    const changed = paths.filter((path) => allTests.includes(path));
    const tests = [...new Set(fullBackend ? allTests : [...changed, ...mapped])].sort();
    if (!tests.length) tests.push(...related);
    if (!tests.length) throw Object.assign(new ConfigurationError("No backend test covers the ticket paths; add or identify a ticket test before verification."), { code: "VERIFY_TEST_SCOPE_EMPTY" });
    checks.push({ kind: "backend_tests", scope: "ticket", test_paths: tests, criterion_ids: verificationPlan.filter((step) => tests.includes(step.test_path)).flatMap((step) => step.criterion_ids ?? []), argv: testArgv(tests) });
  }
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) {
    const entries = await readdir(join(root, "ui/nextjs/tests"), { withFileTypes: true });
    const available = entries.filter((entry) => entry.isFile() && /\.test\.[cm]?js$/.test(entry.name)).map((entry) => `ui/nextjs/tests/${entry.name}`);
    const tests = selectNamedTests(paths, available, "ui/nextjs/");
    const mapped = verificationPlan.filter((step) => step?.kind === "test" && available.includes(step.test_path)).map((step) => step.test_path);
    const primary = [...new Set([...paths.filter((path) => available.includes(path)), ...mapped])];
    if (!primary.length) primary.push(...tests);
    if (primary.length) checks.push({ kind: "test", scope: "ticket", test_paths: primary, argv: testArgv(primary) });
    checks.push({ kind: "build", scope: verificationPlan.some((step) => step?.kind === "build") ? "ticket" : "regression", reason: "UI compilation after ticket UI changes", argv: [process.execPath, "ui/nextjs/node_modules/next/dist/bin/next", "build", "ui/nextjs", "--webpack"] });
  }
  for (const step of verificationPlan) {
    if (step?.kind === "browser") {
      assertCodingBrowserStep(step);
      checks.push({ kind: "browser", browser_step: step, argv: [process.execPath, fileURLToPath(new URL("../../../scripts/verify-ticket-browser.mjs", import.meta.url)), Buffer.from(JSON.stringify(step)).toString("base64url")] });
      continue;
    }
    if (step?.kind !== "test" || typeof step.test_path !== "string" || commandsContainTest(checks, step.test_path)) continue;
    if (!/^(?:backend\/tests|ui\/nextjs\/tests)\/.+\.test\.[cm]?[jt]sx?$/.test(step.test_path)) throw new ConfigurationError(`Verification test path is outside supported test directories: ${step.test_path}`);
    checks.push({ kind: "test", scope: "ticket", test_paths: [step.test_path], criterion_ids: step.criterion_ids ?? [], argv: testArgv([step.test_path]) });
  }
  if (!checks.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
  return [...checks.filter((check) => check.kind === "browser"), ...checks.filter((check) => check.kind !== "browser" && check.scope !== "regression"), ...checks.filter((check) => check.scope === "regression")];
}

// Avoids running a focused test twice when source-based selection already chose it.
function commandsContainTest(checks, path) { return checks.some((check) => ["test", "backend_tests"].includes(check.kind) && check.argv?.includes(path)); }

/** Supports older tickets without a mapped plan using exact test names only.
 * Shared imports do not establish acceptance coverage and never expand the plan. */
function selectNamedTests(paths, tests, sourcePrefix = "backend/src/") {
  const names = new Set(paths.filter(path => path.startsWith(sourcePrefix)).map(path => basename(path).replace(/\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/, "")));
  return tests.filter(path => paths.includes(path) || names.has(basename(path).replace(/\.test\.[cm]?js$/, ""))).sort();
}

/** Gives ticket tests and supplemental regressions the same structured failure
 * protocol so repair responses contain failed assertions instead of PASS logs. */
function testArgv(paths) {
  return [process.execPath, "--test", `--test-reporter=${fileURLToPath(new URL("./ticket-verification-reporter.js", import.meta.url))}`, ...paths];
}

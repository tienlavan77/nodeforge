// Selects the complete immutable checks required to accept a ticket commit.
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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
    const related = fullBackend ? allTests : await selectRelatedTests(paths, allTests, root);
    const mapped = verificationPlan.filter((step) => step?.kind === "test" && allTests.includes(step.test_path)).map((step) => step.test_path);
    const changed = paths.filter((path) => allTests.includes(path));
    const tests = [...new Set(fullBackend ? allTests : [...changed, ...mapped])].sort();
    if (!tests.length) tests.push(...related);
    if (!tests.length) throw Object.assign(new ConfigurationError("No backend test covers the ticket paths; add or identify a ticket test before verification."), { code: "VERIFY_TEST_SCOPE_EMPTY" });
    checks.push({ kind: "backend_tests", scope: "ticket", test_paths: tests, criterion_ids: verificationPlan.filter((step) => tests.includes(step.test_path)).flatMap((step) => step.criterion_ids ?? []), argv: [process.execPath, "--test", ...tests] });
    for (const path of related.filter((path) => !tests.includes(path))) checks.push(regressionTest(path, paths, "backend_tests"));
  }
  if (paths.some((path) => path.startsWith("ui/nextjs/"))) {
    const entries = await readdir(join(root, "ui/nextjs/tests"), { withFileTypes: true });
    const available = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".test.js")).map((entry) => `ui/nextjs/tests/${entry.name}`);
    const tests = await selectRelatedTests(paths, available, root, "ui/nextjs/");
    const mapped = verificationPlan.filter((step) => step?.kind === "test" && available.includes(step.test_path)).map((step) => step.test_path);
    const primary = [...new Set([...paths.filter((path) => available.includes(path)), ...mapped])];
    if (!primary.length) primary.push(...tests);
    if (primary.length) checks.push({ kind: "test", scope: "ticket", test_paths: primary, argv: [process.execPath, "--test", ...primary] });
    for (const path of tests.filter((path) => !primary.includes(path))) checks.push(regressionTest(path, paths, "test"));
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
    checks.push({ kind: "test", scope: "ticket", test_paths: [step.test_path], criterion_ids: step.criterion_ids ?? [], argv: [process.execPath, "--test", step.test_path] });
  }
  if (!checks.length) checks.push({ kind: "typecheck", argv: [process.execPath, "node_modules/typescript/bin/tsc", "--project", "jsconfig.json"] });
  return [...checks.filter((check) => check.kind === "browser"), ...checks.filter((check) => check.kind !== "browser" && check.scope !== "regression"), ...checks.filter((check) => check.scope === "regression")];
}

// Avoids running a focused test twice when source-based selection already chose it.
function commandsContainTest(checks, path) { return checks.some((check) => ["test", "backend_tests"].includes(check.kind) && check.argv?.includes(path)); }

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

// Records why an additional test is relevant without making it an approved ticket criterion.
function regressionTest(path, changedPaths, kind) {
  return { kind, scope: "regression", test_paths: [path], related_paths: changedPaths.filter((path) => !path.includes("/tests/")),
    reason: "Test name or direct source import matches a changed ticket file",
    argv: [process.execPath, "--test", `--test-reporter=${fileURLToPath(new URL("./ticket-verification-reporter.js", import.meta.url))}`, path] };
}

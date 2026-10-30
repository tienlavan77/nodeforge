// Verifies real-browser command scheduling, complete viewport evidence and immutable report acceptance gates.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { CODING_BROWSER_ASSERTIONS } from "../../src/modules/supervisor/browser/browser-coding-contract.js";
import { browserStepSha, browserCommandOutput, matchesBrowserEvidence } from "../../src/modules/supervisor/browser/browser-verification-evidence.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket/ticket-verification-plan.js";
import { coversVerificationPolicy } from "../../src/modules/supervisor/ticket/ticket-verification-policy.js";
import { completeNodeReportEvidence } from "../../src/tools/reporting/node-report-evidence.js";
import { createReportDoneTool } from "../../src/tools/reporting/agent-report-tool.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket/ticket-verification-service.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { loadBrowserTools } from "../../src/modules/supervisor/browser/browser-verification-runner.js";

const step = { kind: "browser", criterion_ids: ["AC-1"], viewports: [1440, 800], assertions: [CODING_BROWSER_ASSERTIONS[9]] };

test("browser tools load root dependencies and never fall back to runtime copies", async () => {
  const root = await mkdtemp(join(process.env.TMPDIR, "browser-tools-"));
  const previousPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
  try {
    for (const base of ["node_modules", ".forge/runtime/browser-tools/node_modules"]) {
      for (const name of ["playwright", "esbuild"]) {
        const directory = join(root, base, name);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "package.json"), JSON.stringify({ name, version: base === "node_modules" ? "1.0.0" : "9.0.0", main: "index.cjs" }));
        await writeFile(join(directory, "index.cjs"), name === "playwright" ? 'module.exports = { chromium: "root-chromium" };' : 'module.exports = { build: "root-build" };');
      }
    }
    const tools = loadBrowserTools(root);
    assert.equal(tools.chromium, "root-chromium");
    assert.equal(tools.build, "root-build");
    assert.deepEqual(tools.versions, { playwright: "1.0.0", esbuild: "1.0.0" });
    assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, "0");
    const missingRoot = join(root, "missing-root");
    const legacyPackage = join(missingRoot, ".forge/runtime/browser-tools/node_modules/playwright");
    await mkdir(legacyPackage, { recursive: true });
    await writeFile(join(legacyPackage, "package.json"), JSON.stringify({ main: "index.cjs" }));
    await writeFile(join(legacyPackage, "index.cjs"), 'throw new Error("Runtime fallback must not load");');
    await writeFile(join(missingRoot, "package.json"), "{}");
    assert.throws(() => loadBrowserTools(missingRoot), { code: "VERIFY_BROWSER_TOOLS_MISSING" });
  } finally {
    if (previousPath === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

// Produces a browser receipt in the format emitted only after every real-browser assertion succeeds.
function receipt(browserStep = step) {
  return { step_sha256: browserStepSha(browserStep), browser_version: "Chromium 123", results: browserStep.viewports.map((viewport) => ({ viewport, passed: true, assertions: [...browserStep.assertions] })) };
}

test("approved browser step schedules the Node-owned runner with the complete exact plan", async () => {
  const commands = await buildTicketVerificationPlan([], process.cwd(), { verificationPlan: [step] });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].kind, "browser");
  assert.match(commands[0].argv[1], /backend\/scripts\/verify-ticket-browser\.mjs$/);
  assert.deepEqual(JSON.parse(Buffer.from(commands[0].argv[2], "base64url").toString()), step);
  assert.deepEqual(commands[0].browser_step, step);
});

test("unimplemented browser prose fails closed instead of becoming a generic smoke", async () => {
  await assert.rejects(buildTicketVerificationPlan([], process.cwd(), { verificationPlan: [{ ...step, assertions: ["Invented unrelated assertion"] }] }), { code: "VERIFY_BROWSER_SCENARIO_REQUIRED" });
});

test("receipt must cover every approved assertion and viewport with the exact step hash", () => {
  assert.equal(matchesBrowserEvidence(step, receipt()), true);
  for (const mutate of [
    (value) => { value.results.pop(); },
    (value) => { value.results[0].assertions = []; },
    (value) => { value.results[0].viewport = 1200; },
    (value) => { value.results[0].passed = false; },
    (value) => { value.step_sha256 = "different"; },
    (value) => { delete value.browser_version; }
  ]) {
    const value = receipt(); mutate(value);
    assert.equal(matchesBrowserEvidence(step, value), false);
  }
});

test("zero process exit without valid browser evidence is a failed command", () => {
  const command = { kind: "browser", browser_step: step };
  const valid = browserCommandOutput(command, { exit_code: 0, stdout: JSON.stringify(receipt()), stderr: "" });
  assert.deepEqual(valid.browser_evidence, receipt());
  assert.equal(valid.exit_code, 0);
  for (const stdout of ["PASS", "{}", JSON.stringify({ ...receipt(), results: [] })]) {
    const invalid = browserCommandOutput(command, { exit_code: 0, stdout, stderr: "" });
    assert.equal(invalid.exit_code, 1);
    assert.match(invalid.stderr, /VERIFY_BROWSER_EVIDENCE_INVALID/);
  }
});

test("old passed artifact cannot be reused if the approved browser step was never executed", () => {
  const build = { kind: "build", argv: ["node", "build"], exit_code: 0, output_sha256: `sha256:${"a".repeat(64)}` };
  const artifact = { policy_version: "ticket-verification-v5", planned_commands: [build], commands: [build] };
  assert.equal(coversVerificationPolicy(artifact, ["ui/nextjs/app/coding/page.jsx"], [step]), false);
  const browser = { kind: "browser", argv: ["node", "browser"], exit_code: 0, output_sha256: build.output_sha256, browser_evidence: receipt() };
  artifact.planned_commands.push(browser); artifact.commands.push(browser);
  assert.equal(coversVerificationPolicy(artifact, ["ui/nextjs/app/coding/page.jsx"], [step]), true);
});

test("browser-only AC can report completion only with valid matching Node-owned evidence", async () => {
  const artifact = { artifact_id: "ARTIFACT-1", changed_paths: [], file_checksums: {}, commands: [{ kind: "browser", exit_code: 0, browser_evidence: receipt() }] };
  const ticket = { id: "TICKET-1", acceptance_criteria: ["Sprint controls retain behavior"], verification_plan: [step] };
  const coverage = completeNodeReportEvidence({ summary: "Verified controls" }, ticket, artifact).acceptance_coverage;
  assert.equal(coverage[0].status, "verified");
  assert.equal(coverage[0].command_kind, "browser");
  let saved;
  const tool = createReportDoneTool({ verificationService: { assertPassedArtifact: async () => artifact }, reportService: { buildFinalReport: async () => ({}), saveReport: async (_id, report) => { saved = report; }, writeReportFile: async () => {} } });
  await tool.execute({ summary: "Verified controls" }, { ticket });
  assert.equal(saved.criteria_check[0].node_verified, true);
  delete artifact.commands[0].browser_evidence;
  await assert.rejects(tool.execute({ summary: "No browser evidence" }, { ticket }), { code: "CODER_EVIDENCE_PENDING" });
});

test("report input schema permits browser evidence type without accepting arbitrary extra fields", () => {
  const require = createRequire(import.meta.url);
  const schema = require("../../../schemas/agent/tools/report-done.schema.json");
  const validate = new Ajv2020({ strict: false }).compile(schema);
  assert.equal(validate({ summary: "Browser verified", acceptance_coverage: [{ criterion_id: "AC-1", command_kind: "browser", status: "verified" }] }), true);
});

test("browser runner and fixture exist separately from the committed ticket sources", async () => {
  assert.match(await readFile(new URL("../../scripts/verify-ticket-browser.mjs", import.meta.url), "utf8"), /runBrowserVerification/);
  assert.match(await readFile(new URL("../../src/modules/supervisor/browser/browser-coding-fixture.js", import.meta.url), "utf8"), /@ticket\/ui\/components\/coding-workspace-monitor/);
});

// Verifies service integration with deterministic command outputs, not a substitute for real Chromium acceptance.
test("verification service persists browser evidence and rejects missing receipts before artifact reuse", async () => {
  await mkdir(join(process.cwd(), ".forge/scratch"), { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".forge/scratch/browser-service-"));
  const path = "ui/nextjs/lib/example.js";
  const content = "export const example = true;\n";
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  try {
    await mkdir(join(root, "ui/nextjs/lib"), { recursive: true });
    await mkdir(join(root, "ui/nextjs/tests"), { recursive: true });
    await writeFile(join(root, path), content);
    let context = { state: "committed", version: 1, base_sha: "BASE", source_revision: "SOURCE", manifest_sha: "MANIFEST", manifest_paths: [path], review_commit_sha: "COMMIT", verification_artifact_id: null, verification_plan: [step] };
    const files = createFileService({ projectRoot: root });
    const commands = [];
    const service = createTicketVerificationService({ taskId: "TICKET-BROWSER", projectId: "PROJECT-BROWSER", projectRoot: root, worktreeRoot: root, stateFileService: files, worktreeFileService: files,
      gitService: { getHead: async () => "COMMIT", status: async () => "", getCommitParent: async () => "BASE", getChangedFiles: async () => [path] },
      ledger: { snapshot: async () => ({ entries: { [path]: { latest_sha: checksum } } }) },
      executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: "SOURCE", manifest_sha: "MANIFEST", manifest_paths: [path] }), update: async (_id, version, patch) => { assert.equal(version, context.version); context = { ...context, ...patch, version: version + 1 }; return context; } },
      runCommand: async (command) => { commands.push(command); return { exit_code: 0, stdout: command.kind === "browser" ? JSON.stringify(receipt(command.browser_step)) : "Build passed", stderr: "", output_sha256: `sha256:${"a".repeat(64)}` }; }
    });
    const job = await service.startTests();
    let result;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      result = await service.getTestResult({ jobId: job.job_id });
      if (result.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.deepEqual(commands.map((command) => command.kind), ["browser", "build"]);
    const artifact = await service.assertPassedArtifact();
    assert.equal(artifact.policy_version, "ticket-verification-v6");
    assert.deepEqual(artifact.commands[0].browser_evidence, receipt());
    const artifactPath = `.forge/runtime/ticket-verification/TICKET-BROWSER/artifacts/${artifact.artifact_id}.json`;
    delete artifact.commands[0].browser_evidence;
    await files.atomicWrite({ path: artifactPath, content: JSON.stringify(artifact), replace: true });
    await assert.rejects(service.assertPassedArtifact(), { code: "VERIFY_ARTIFACT_MISMATCH" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

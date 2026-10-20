// Exercises ticket-scoped acceptance and real baseline regression attribution without touching the project runtime.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { coversVerificationPolicy } from "../../src/modules/supervisor/ticket-verification-policy.js";
import { completeNodeReportEvidence } from "../../src/tools/node-report-evidence.js";

const execute = promisify(execFile);
const source = "backend/src/shared.js";
const primary = "backend/tests/unit/ticket.test.js";
const regression = "backend/tests/unit/existing.test.js";
const hash = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

// Creates a shared module change, an AC-mapped ticket test, and a separately owned regression test.
async function fixture({ assertion = "assert.equal(1, 0)", mappedRegression = false, primaryFails = false, missingBaseline = false, schemaFails = false, requiredSchema = false, rootOnly = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-regression-"));
  const git = createTicketRootGit({ projectRoot: root });
  for (const path of ["backend/src", "backend/tests/unit", "backend/scripts"]) await mkdir(join(root, path), { recursive: true });
  await git.run(["init"]); await git.run(["config", "user.name", "Test"]); await git.run(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  await writeFile(join(root, source), "export const value = 1;\n");
  await writeFile(join(root, regression), `import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../../src/shared.js';\ntest('legacy regression', () => { ${assertion}; });\n`);
  await git.run(["add", "."]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const base = (await git.run(["rev-parse", "HEAD"])).trim();
  const content = "export const value = 2;\n";
  const testContent = `import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../../src/shared.js';\ntest('ticket AC', () => assert.equal(value, ${primaryFails ? 99 : 2}));\n`;
  await writeFile(join(root, source), content); await writeFile(join(root, primary), testContent);
  await git.run(["add", source, primary]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "ticket"]);
  const commit = (await git.run(["rev-parse", "HEAD"])).trim();
  const paths = [source, primary].sort();
  const entries = { [source]: { latest_sha: hash(content) }, [primary]: { latest_sha: hash(testContent) } };
  const plan = [{ kind: "test", criterion_ids: ["AC-1"], test_path: primary }];
  if (mappedRegression) plan.push({ kind: "test", criterion_ids: ["AC-2"], test_path: regression });
  if (requiredSchema) plan.push({ kind: "schema_validation", criterion_ids: ["AC-2"] });
  const context = { task_id: "T-REGRESSION", project_id: "P", state: "committed", version: 1, base_sha: missingBaseline ? "0".repeat(40) : base,
    source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths, review_commit_sha: commit, verification_plan: plan };
  const events = [];
  const calls = [];
  const files = createFileService({ projectRoot: root });
  const service = createTicketVerificationService({ taskId: context.task_id, projectId: "P", projectRoot: root, worktreeRoot: root, rootOnly,
    worktreeFileService: files, stateFileService: files,
    gitService: { getHead: async () => commit, status: async () => "", getCommitParent: async () => base, getChangedFiles: async () => paths },
    ledger: { load: async () => ({ entries }), snapshot: async () => ({ entries }) },
    executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths }),
      update: async (_id, version, patch) => Object.assign(context, patch, { version: version + 1 }) }, projectLogger: (event) => events.push(event),
    runCommand: async ({ kind, argv, cwd }) => {
      calls.push({ kind, argv, cwd });
      if (kind === "schema_validation" && schemaFails) return { exit_code: 1, stdout: "Existing schema defect", stderr: "" };
      if (kind !== "backend_tests" && kind !== "test") return { exit_code: 0, stdout: "PASS", stderr: "" };
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      try { return { exit_code: 0, ...await execute(argv[0], argv.slice(1), { cwd, env }) }; }
      catch (error) { if (typeof error.code !== "number") throw error; return { exit_code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    } });
  return { root, base, context, events, calls, service, close: () => rm(root, { recursive: true, force: true }) };
}

// Waits for the real verification job and loads its immutable artifact.
async function verify(f) {
  const started = await f.service.startTests();
  let job;
  for (let i = 0; i < 300; i += 1) {
    job = await f.service.getTestResult({ jobId: started.job_id });
    if (job.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.notEqual(job.status, "running");
  return { job, artifact: job.artifact_id ? await f.service.loadArtifact(job.artifact_id) : null };
}

test("existing supplemental failure is retained as evidence and does not block AC tests or artifact reuse", async () => {
  const f = await fixture();
  try {
    const { job, artifact } = await verify(f);
    assert.equal(job.status, "passed", JSON.stringify(job));
    const primaryCommand = artifact.commands.find((command) => command.scope === "ticket");
    assert.deepEqual(primaryCommand.test_paths, [primary]);
    assert.equal(primaryCommand.exit_code, 0);
    const result = artifact.commands.find((command) => command.disposition === "preexisting_failure");
    assert.equal(result.exit_code, 1); assert.equal(result.baseline.commit_sha, f.base);
    assert.equal(result.failure_sha256, result.baseline.failure_sha256);
    assert.equal(result.baseline.environment_sha256, artifact.environment.sha256);
    assert.equal((await f.service.assertPassedArtifact()).artifact_id, artifact.artifact_id);
    const report = completeNodeReportEvidence({}, { acceptance_criteria: ["Ticket behavior works"], verification_plan: f.context.verification_plan }, artifact);
    assert.equal(report.acceptance_coverage[0].status, "verified");
    assert.equal(report.acceptance_coverage[0].test_path, primary);
    assert(report.evidence.some((entry) => entry.result.includes("supplemental preexisting failure")));
    assert(f.events.some((event) => event.event_name === "ticket.verification_regression"));
    assert.deepEqual(await readdir(join(f.root, ".forge/runtime/ticket-verification/archives")), []);
    const forged = structuredClone(artifact);
    forged.commands.find((command) => command.baseline).baseline.failure_sha256 = "forged";
    assert.equal(coversVerificationPolicy(forged, artifact.changed_paths, f.context.verification_plan), false);
    const missingMapping = structuredClone(artifact);
    missingMapping.commands.find((command) => command.scope === "ticket").scope = "regression";
    assert.equal(coversVerificationPolicy(missingMapping, artifact.changed_paths, f.context.verification_plan), false);
  } finally { await f.close(); }
});

for (const [name, options, disposition] of [
  ["new regression", { assertion: "assert.equal(value, 1)" }, "introduced_failure"],
  ["different assertion failure", { assertion: "assert.equal(value, 0)" }, "changed_failure"],
  ["missing baseline", { missingBaseline: true }, "unattributed_failure"]
]) {
  test(`${name} blocks completion instead of being waived because both commands failed`, async () => {
    const f = await fixture(options);
    try {
      const { job, artifact } = await verify(f);
      assert.equal(job.status, "failed");
      assert.equal(artifact.commands.at(-1).disposition, disposition);
      await assert.rejects(f.service.assertPassedArtifact(), { code: "VERIFY_ARTIFACT_MISMATCH" });
    } finally { await f.close(); }
  });
}

for (const options of [{ primaryFails: true }, { mappedRegression: true }]) {
  test(`ticket-mapped failures always block without a baseline exemption: ${JSON.stringify(options)}`, async () => {
    const f = await fixture(options);
    try {
      const { job, artifact } = await verify(f);
      assert.equal(job.status, "failed");
      assert.equal(artifact.commands.at(-1).scope, "ticket");
      assert(!artifact.commands.some((command) => command.baseline));
    } finally { await f.close(); }
  });
}

test("shared schema failure also requires identical pre-ticket evidence", async () => {
  const f = await fixture({ schemaFails: true });
  try {
    const { job, artifact } = await verify(f);
    assert.equal(job.status, "passed", JSON.stringify(job));
    assert.equal(artifact.commands.find((command) => command.kind === "schema_validation").disposition, "preexisting_failure");
    await f.service.assertPassedArtifact();
  } finally { await f.close(); }
});

test("explicit schema acceptance requirement cannot be waived as an existing project failure", async () => {
  const f = await fixture({ schemaFails: true, requiredSchema: true });
  try {
    const { job, artifact } = await verify(f);
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "VERIFY_COMMAND_FAILED");
    assert.equal(artifact.commands.at(-1).kind, "schema_validation");
    assert.equal(artifact.commands.at(-1).scope, "ticket");
    assert(!artifact.commands.at(-1).baseline);
  } finally { await f.close(); }
});

test("worktree verification reproduces a supplemental failure under the same snapshot before baseline attribution", async () => {
  const f = await fixture({ rootOnly: false });
  try {
    const { job, artifact } = await verify(f);
    assert.equal(job.status, "passed", JSON.stringify(job));
    const result = artifact.commands.find((command) => command.disposition === "preexisting_failure");
    assert.equal(result.reproduction.commit_sha, f.context.review_commit_sha);
    assert.equal(result.reproduction.environment_sha256, result.baseline.environment_sha256);
    await f.service.assertPassedArtifact();
  } finally { await f.close(); }
});

test("repair diagnostics distinguish an existing failure from a later regression introduced by the ticket", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, "backend/tests/unit/zzz-new.test.js"), "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../../src/shared.js'; test('new regression', () => assert.equal(value, 1));\n");
    const { job } = await verify(f);
    assert.equal(job.status, "failed");
    const diagnostic = await f.service.getFailureDiagnostic();
    assert.equal(diagnostic.repairable, true);
    assert.equal(diagnostic.commands.find((command) => command.disposition === "preexisting_failure").blocking, false);
    assert.equal(diagnostic.commands.find((command) => command.disposition === "introduced_failure").blocking, true);
    assert.match(diagnostic.repair_guidance, /Do not repair supplemental preexisting_failure/);
  } finally { await f.close(); }
});

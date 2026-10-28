/** Builds real committed candidate/baseline trees with a deliberately unreadable
 * first regression receipt. Recovery must restore evidence, preserve primary
 * acceptance checks and finish the original remaining plan without live-source edits. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket-root-git.js";
import { buildLegacyRegressionPlan } from "../fixtures/legacy-verification-plan.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";

/** Creates an isolated verification service whose source and environment outlive a simulated runner restart. */
export async function baselineFixture({ introduced = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-baseline-recovery-"));
  const git = createTicketRootGit({ projectRoot: root });
  const source = "backend/src/shared.js", primary = "backend/tests/unit/ticket.test.js";
  const regression = "backend/tests/unit/existing.test.js", trailing = "backend/tests/unit/z-existing.test.js";
  const files = createFileService({ projectRoot: root });
  for (const path of ["backend/src", "backend/tests/unit"]) await mkdir(join(root, path), { recursive: true });
  await git.run(["init"]); await git.run(["config", "user.name", "Test"]); await git.run(["config", "user.email", "test@example.invalid"]);
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  await writeFile(join(root, source), "export const value = 1;\n");
  await writeFile(join(root, regression), `import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../src/shared.js';
test('legacy regression',()=>{${introduced ? "assert.equal(value,1)" : "assert.equal(1,0)"};});\n`);
  await writeFile(join(root, trailing), "import test from 'node:test'; import {value} from '../../src/shared.js'; test('remaining regression',()=>{ if(!value) throw Error('missing'); });\n");
  await git.run(["add", "."]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "baseline"]);
  const base = (await git.run(["rev-parse", "HEAD"])).trim();
  const content = "export const value = 2;\n";
  const testContent = "import test from 'node:test'; import assert from 'node:assert/strict'; import {value} from '../../src/shared.js'; test('ticket AC',()=>assert.equal(value,2));\n";
  await writeFile(join(root, source), content); await writeFile(join(root, primary), testContent);
  await git.run(["add", source, primary]); await git.run(["-c", "core.hooksPath=/dev/null", "commit", "-m", "ticket"]);
  const commit = (await git.run(["rev-parse", "HEAD"])).trim();
  const paths = [source, primary].sort();
  const entries = Object.fromEntries([[source, content], [primary, testContent]].map(([path, value]) =>
    [path, { latest_sha: `sha256:${createHash("sha256").update(value).digest("hex")}` }]));
  const context = { task_id: "T-BASELINE", project_id: "P", version: 1, state: "committed", base_sha: base, review_commit_sha: commit,
    source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths,
    verification_plan: [{ kind: "test", criterion_ids: ["AC-1"], test_path: primary }] };
  const calls = [], logs = [];
  let malformed = true;
  const execute = promisify(execFile);
  const options = { taskId: context.task_id, projectId: "P", projectRoot: root, worktreeRoot: root, rootOnly: true,
    worktreeFileService: files, stateFileService: files, buildPlan: buildLegacyRegressionPlan, projectLogger: event => logs.push(event),
    gitService: { getHead: async () => commit, status: async () => "", getCommitParent: async () => base, getChangedFiles: async () => paths },
    ledger: { load: async () => ({ entries }), snapshot: async () => ({ entries }) },
    executionContexts: { load: async () => ({ ...context }), manifestIdentity: () => ({ source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths }),
      update: async (_id, version, patch) => { if (context.version !== version) throw Error("stale context"); Object.assign(context, patch, { version: version + 1 }); } },
    runCommand: async input => {
      calls.push(input);
      if (input.kind !== "backend_tests") return { exit_code: 0, stdout: "PASS", stderr: "" };
      if (malformed && input.argv.includes(regression)) { malformed = false; return { exit_code: 1, stdout: "old malformed reporter output", stderr: "" }; }
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      try { return { exit_code: 0, ...await execute(input.argv[0], input.argv.slice(1), { cwd: input.cwd, env, signal: input.signal }) }; }
      catch (error) { if (typeof error.code !== "number") throw error; return { exit_code: error.code, stdout: error.stdout, stderr: error.stderr }; }
    } };
  const service = createTicketVerificationService(options);
  return { root, files, context, options, calls, logs, source, primary, regression, trailing, service, close: () => rm(root, { recursive: true, force: true }) };
}

/** Waits for the ordinary asynchronous job to persist its real terminal evidence. */
export async function failedBaseline(fixture) {
  const started = await fixture.service.startTests();
  for (let index = 0; index < 300; index++) {
    const job = await fixture.service.getTestResult({ jobId: started.job_id });
    if (job.status !== "running") return { job, artifact: await fixture.service.loadArtifact(job.artifact_id) };
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw Error("Fixture verification did not finish.");
}

/** Supplies real Git revisions and immutable environment evidence for review
 * verification tests without using production ticket data or provider requests. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketRootGit } from "../../src/modules/supervisor/ticket/ticket-root-git.js";
import { captureVerificationEnvironment, persistVerificationEnvironment } from "../../src/modules/supervisor/ticket/ticket-verification-environment.js";
import { createReviewVerificationService } from "../../src/modules/supervisor/review/review-verification-service.js";

const execute = promisify(execFile);

/** Builds deliberately different committed and live files so tests detect any
 * accidental use of mutable source or freshly captured environment data. */
export async function reviewVerificationFixture({ failing = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "nf-review-verification-"));
  const git = createTicketRootGit({ projectRoot: root });
  await git.run(["init", "--quiet"]);
  await git.run(["config", "user.name", "Fixture"]); await git.run(["config", "user.email", "test@example.invalid"]);
  await mkdir(join(root, "backend/src"), { recursive: true }); await mkdir(join(root, "backend/tests/unit"), { recursive: true });
  await writeFile(join(root, ".gitignore"), ".forge/\n");
  const path = "backend/src/feature.mjs";
  await writeFile(join(root, path), "export const value = 0;\n");
  await git.run(["add", "."]); await git.run(["commit", "--quiet", "-m", "Baseline"]);
  const base = (await git.run(["rev-parse", "HEAD"])).trim();
  const source = "export const value = 1;\n";
  await writeFile(join(root, path), source);
  await git.run(["add", path]); await git.run(["commit", "--quiet", "-m", "Ticket change"]);
  const commit = (await git.run(["rev-parse", "HEAD"])).trim();
  await writeFile(join(root, "backend/src/dependency.mjs"), "export const dependency = 42;\n");
  const testPath = "backend/tests/unit/feature.test.mjs";
  await writeFile(join(root, testPath), 'import test from "node:test";\nimport assert from "node:assert/strict";\nimport {value} from "../../src/feature.mjs";\nimport {dependency} from "../../src/dependency.mjs";\n' +
    (failing ? 'test("preexisting assertion",()=>assert.equal(2,1));\n' : 'test("reviewed source and recorded dependency",()=>{assert.equal(value,1);assert.equal(dependency,42);});\n'));
  const environment = await persistVerificationEnvironment(root, await captureVerificationEnvironment({ projectRoot: root, ticketPaths: [path] }));
  const artifact = { artifact_id: "ARTIFACT-REVIEW", project_id: "PROJECT-REVIEW", task_id: "TICKET-REVIEW", status: "passed",
    commit_sha: commit, base_sha: base, source_revision: "sha256:source", manifest_sha: "sha256:manifest", environment,
    file_checksums: { [path]: `sha256:${createHash("sha256").update(source).digest("hex")}` } };
  const request = { finding_ids: ["REV-1"], criterion_ids: ["AC-1"], test_paths: [testPath], scope: "ticket", reason: "Verify the current finding on the reviewed source.",
    artifact_id: artifact.artifact_id, commit_sha: commit, source_revision: artifact.source_revision };
  await writeFile(join(root, path), "throw new Error('Live source must not run');\n");
  await writeFile(join(root, "backend/src/dependency.mjs"), "export const dependency = 13;\n");
  const stateFileService = createFileService({ projectRoot: root });
  let commands = 0;
  const logs = [];
  // Executes the same argument-vector checks as Node while retaining nonzero test output for baseline attribution.
  async function runCommand({ argv, cwd, signal }) {
    commands++;
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    try { const output = await execute(argv[0], argv.slice(1), { cwd, signal, env, maxBuffer: 1_000_000 }); return { ...output, exit_code: 0 }; }
    catch (error) { if (!Number.isInteger(error.code)) throw error; return { exit_code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  }
  const options = { taskId: artifact.task_id, projectId: artifact.project_id, projectRoot: root, stateFileService,
    runCommand, safeOutput: (value) => String(value ?? "").slice(0, 65536), projectLogger: (event) => logs.push(event) };
  return { root, git, path, testPath, source, artifact, request, options, logs, commands: () => commands,
    service: createReviewVerificationService(options), close: () => rm(root, { recursive: true, force: true }) };
}

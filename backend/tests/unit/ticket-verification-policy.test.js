// Proves immutable ticket verification cannot pass without schema and complete backend checks.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createTicketVerificationService } from "../../src/modules/supervisor/ticket-verification-service.js";
import { buildTicketVerificationPlan } from "../../src/modules/supervisor/ticket-verification-plan.js";

test("backend policy selects ticket tests, with full suite reserved for an explicit release gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-plan-"));
  try {
    await mkdir(join(root, "backend/tests/unit"), { recursive: true });
    await mkdir(join(root, "backend/tests/integration"), { recursive: true });
    await mkdir(join(root, "ui/nextjs/tests"), { recursive: true });
    await writeFile(join(root, "backend/tests/unit/first.test.js"), "// First test.\n");
    await writeFile(join(root, "backend/tests/integration/second.test.js"), "// Second test.\n");
    await writeFile(join(root, "ui/nextjs/tests/node-client.test.js"), "import '../lib/node-client.js';\n");
    await writeFile(join(root, "ui/nextjs/tests/unrelated.test.js"), "// Unrelated UI test.\n");
    const commands = await buildTicketVerificationPlan(["backend/src/sample.js", "backend/tests/unit/first.test.js"], root);
    assert.deepEqual(commands.map(({ kind }) => kind), ["typecheck", "lint", "schema_validation", "backend_tests"]);
    assert.deepEqual(commands.at(-1).argv.slice(2), ["backend/tests/unit/first.test.js"]);
    const release = await buildTicketVerificationPlan(["backend/src/sample.js", "backend/tests/unit/first.test.js"], root, { fullBackend: true });
    assert.deepEqual(release.at(-1).argv.slice(2), ["backend/tests/integration/second.test.js", "backend/tests/unit/first.test.js"]);
    await assert.rejects(buildTicketVerificationPlan(["backend/src/uncovered.js"], root), (error) => error.code === "VERIFY_TEST_SCOPE_EMPTY");
    const apiCommands = await buildTicketVerificationPlan(["ui/nextjs/lib/node-client.js"], root);
    assert.equal(apiCommands.some(({ kind }) => kind === "schema_validation"), true);
    assert.deepEqual(apiCommands.find(({ kind }) => kind === "test").argv.slice(2), ["ui/nextjs/tests/node-client.test.js"]);
    const mapped = await buildTicketVerificationPlan(["ui/nextjs/lib/node-client.js"], root, { verificationPlan: [{ criterion_ids: ["AC-1"], kind: "test", test_path: "ui/nextjs/tests/unrelated.test.js" }] });
    assert.equal(mapped.some(({ kind, argv }) => kind === "test" && argv.includes("ui/nextjs/tests/unrelated.test.js")), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed schema validation persists a failed artifact and blocks acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-schema-"));
  const path = "backend/src/sample.js";
  const content = "// Verified source.\nexport const sample = true;\n";
  const untouchedPath = "backend/src/untouched.js";
  const untouchedContent = "// Keeps an unchanged source in the signed ticket manifest.\nexport const untouched = true;\n";
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "backend/tests/unit"), { recursive: true });
    await writeFile(join(root, path), content);
    await writeFile(join(root, untouchedPath), untouchedContent);
    await writeFile(join(root, "backend/tests/unit/sample.test.js"), "// Verifies sample source.\n");
    await writeFile(join(root, "backend/tests/unit/untouched.test.js"), "// Verifies unchanged source.\n");
    const files = createFileService({ projectRoot: root });
    const manifest = { entries: { [path]: { latest_sha: checksum }, [untouchedPath]: { latest_sha: `sha256:${createHash("sha256").update(untouchedContent).digest("hex")}` } } };
    const context = { state: "committed", version: 1, base_sha: "BASE", source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: [path, untouchedPath], review_commit_sha: "COMMIT", verification_artifact_id: null };
    const service = createTicketVerificationService({ taskId: "T-SCHEMA", projectId: "P-SCHEMA", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files,
      gitService: { getHead: async () => "COMMIT", status: async () => "", getCommitParent: async () => "PARENT", getChangedFiles: async () => [path] }, ledger: { snapshot: async () => manifest },
      executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: [path, untouchedPath] }), update: async () => { throw new Error("Failed schema must not verify context"); } },
      runCommand: async ({ kind }) => kind === "schema_validation" ? { exit_code: 1, stdout: "schema failed", stderr: "" } : { exit_code: 0, stdout: "passed", stderr: "" } });
    const started = await service.startTests();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await service.getTestResult({ jobId: started.job_id });
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "failed");
    assert.equal(job.error.code, "VERIFY_COMMAND_FAILED");
    const artifact = await service.loadArtifact(job.artifact_id);
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.commands.at(-1).kind, "schema_validation");
    assert.equal(artifact.commands.at(-1).exit_code, 1);
    assert.deepEqual(artifact.changed_paths, [path]);
    assert.deepEqual(artifact.planned_commands.find(({ kind }) => kind === "backend_tests").argv.slice(2), ["backend/tests/unit/sample.test.js"]);
    await assert.rejects(service.assertPassedArtifact(), (error) => error.code === "VERIFY_ARTIFACT_MISMATCH");
    context.verification_artifact_id = "ARTIFACT-LEGACY";
    const legacy = { ...artifact, artifact_id: context.verification_artifact_id, status: "passed", policy_version: "ticket-verification-v2", commands: [{ kind: "typecheck", argv: ["node", "check"], exit_code: 0, output_sha256: checksum }], planned_commands: [{ kind: "typecheck", argv: ["node", "check"] }] };
    const artifactPath = `.forge/runtime/ticket-verification/T-SCHEMA/artifacts/${context.verification_artifact_id}.json`;
    await files.atomicWrite({ path: artifactPath, content: JSON.stringify(legacy), replace: true });
    await assert.rejects(service.assertPassedArtifact(), (error) => error.code === "VERIFY_ARTIFACT_MISMATCH");
    await files.atomicWrite({ path: artifactPath, content: JSON.stringify({ ...legacy, policy_version: "ticket-verification-v3" }), replace: true });
    await assert.rejects(service.assertPassedArtifact(), (error) => error.code === "VERIFY_ARTIFACT_MISMATCH");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("passed commit-scoped artifact remains valid when the manifest also contains untouched UI files", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-commit-scope-"));
  const changed = "backend/src/sample.js";
  const untouched = "ui/nextjs/lib/ui-error.js";
  const source = "// Supplies ticket source.\nexport const sample = true;\n";
  const uiSource = "// Supplies unchanged UI source.\nexport const error = null;\n";
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "backend/tests/unit"), { recursive: true });
    await mkdir(join(root, "ui/nextjs/lib"), { recursive: true });
    await writeFile(join(root, changed), source);
    await writeFile(join(root, untouched), uiSource);
    await writeFile(join(root, "backend/tests/unit/sample.test.js"), "// Checks ticket source.\n");
    const files = createFileService({ projectRoot: root });
    const paths = [changed, untouched];
    const manifest = { entries: { [changed]: { latest_sha: digest(source) }, [untouched]: { latest_sha: digest(uiSource) } } };
    const context = { state: "committed", version: 1, base_sha: "BASE", source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths, review_commit_sha: "COMMIT", verification_artifact_id: null };
    const service = createTicketVerificationService({ taskId: "T-COMMIT-SCOPE", projectId: "P-COMMIT-SCOPE", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files,
      gitService: { getHead: async () => "COMMIT", status: async () => "", getCommitParent: async () => "PARENT", getChangedFiles: async () => [changed] },
      ledger: { snapshot: async () => manifest },
      executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: paths }), update: async (_taskId, version, patch) => Object.assign(context, patch, { version: version + 1 }) },
      runCommand: async () => ({ exit_code: 0, stdout: "passed", stderr: "" }) });
    const started = await service.startTests();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await service.getTestResult({ jobId: started.job_id });
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "passed", JSON.stringify(job.error));
    const artifact = await service.assertPassedArtifact();
    assert.deepEqual(artifact.changed_paths, [changed]);
    assert.equal(artifact.planned_commands.some(({ kind }) => kind === "build"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

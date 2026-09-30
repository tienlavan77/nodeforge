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

test("backend policy plans schema validation and every backend test", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-plan-"));
  try {
    await mkdir(join(root, "backend/tests/unit"), { recursive: true });
    await mkdir(join(root, "backend/tests/integration"), { recursive: true });
    await mkdir(join(root, "ui/nextjs/tests"), { recursive: true });
    await writeFile(join(root, "backend/tests/unit/first.test.js"), "// First test.\n");
    await writeFile(join(root, "backend/tests/integration/second.test.js"), "// Second test.\n");
    const commands = await buildTicketVerificationPlan(["backend/src/sample.js", "backend/tests/unit/first.test.js"], root);
    assert.deepEqual(commands.map(({ kind }) => kind), ["typecheck", "lint", "schema_validation", "backend_tests"]);
    assert.deepEqual(commands.at(-1).argv.slice(2), ["backend/tests/integration/second.test.js", "backend/tests/unit/first.test.js"]);
    const apiCommands = await buildTicketVerificationPlan(["ui/nextjs/lib/node-client.js"], root);
    assert.equal(apiCommands.some(({ kind }) => kind === "schema_validation"), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed schema validation persists a failed artifact and blocks acceptance", async () => {
  const root = await mkdtemp(join(tmpdir(), "nodeforge-verification-schema-"));
  const path = "backend/src/sample.js";
  const content = "// Verified source.\nexport const sample = true;\n";
  const checksum = `sha256:${createHash("sha256").update(content).digest("hex")}`;
  try {
    await mkdir(join(root, "backend/src"), { recursive: true });
    await mkdir(join(root, "backend/tests/unit"), { recursive: true });
    await writeFile(join(root, path), content);
    await writeFile(join(root, "backend/tests/unit/sample.test.js"), "// Verifies sample source.\n");
    const files = createFileService({ projectRoot: root });
    const manifest = { entries: { [path]: { latest_sha: checksum } } };
    const context = { state: "committed", version: 1, base_sha: "BASE", source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: [path], review_commit_sha: "COMMIT", verification_artifact_id: null };
    const service = createTicketVerificationService({ taskId: "T-SCHEMA", projectId: "P-SCHEMA", projectRoot: root, worktreeRoot: root, worktreeFileService: files, stateFileService: files,
      gitService: { getHead: async () => "COMMIT", status: async () => "" }, ledger: { snapshot: async () => manifest },
      executionContexts: { load: async () => context, manifestIdentity: () => ({ source_revision: "REV", manifest_sha: "MANIFEST", manifest_paths: [path] }), update: async () => { throw new Error("Failed schema must not verify context"); } },
      runCommand: async ({ kind }) => kind === "schema_validation" ? { exit_code: 1, stdout: "schema failed", stderr: "" } : { exit_code: 0, stdout: "passed", stderr: "" } });
    const started = await service.startTests();
    let job;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      job = await service.getTestResult({ jobId: started.job_id });
      if (job.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.status, "failed");
    const artifact = await service.loadArtifact(job.artifact_id);
    assert.equal(artifact.status, "failed");
    assert.equal(artifact.commands.at(-1).kind, "schema_validation");
    assert.equal(artifact.commands.at(-1).exit_code, 1);
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

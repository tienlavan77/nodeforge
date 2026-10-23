// Verifies coordinating agents can inspect their verification evidence without opening unrelated runtime access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, symlink, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { blockerRecoveryTools } from "../../src/modules/supervisor/blocker-recovery-tools.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";

// Creates real receipt files and the same Node-issued recovery progress consumed by both provider adapters.
async function fixture(role) {
  const root = await mkdtemp(join(tmpdir(), "blocker-evidence-"));
  await mkdir(join(root, "backend"));
  await writeFile(join(root, "backend/source.js"), "export const ready = true;\n");
  const prefix = ".forge/runtime/ticket-verification/TICKET-A";
  const refs = { artifact: `${prefix}/artifacts/ARTIFACT-A.json`, job: `${prefix}/jobs/VERIFY-A.json`, check: `${prefix}/checks/CHECK-A.json` };
  const identity = { task_id: "TICKET-A", commit_sha: "a".repeat(40), source_revision: `sha256:${"b".repeat(64)}` };
  const artifact = { ...identity, project_id: "PROJECT-A", artifact_id: "ARTIFACT-A",
    commands: [{ baseline: { stdout_redacted: "baseline assertion evidence" } }] };
  for (const [kind, path] of Object.entries(refs)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    const content = kind === "artifact" ? artifact : { ...identity, [kind === "job" ? "job_id" : "check_id"]: kind === "job" ? "VERIFY-A" : "CHECK-A" };
    await writeFile(join(root, path), JSON.stringify(content, null, 2));
  }
  const job = { stage: role, request: { task_id: "TICKET-A", project_id: "PROJECT-A", execution_context: { base_sha: "c".repeat(40) },
    ticket: { objective: "Inspect retained verification evidence and continue the approved ticket scope." } },
    ticket_progress: { verification: { status: "observed", commit_sha: identity.commit_sha, source_revision: identity.source_revision,
      job: { job_id: "VERIFY-A", evidence_ref: refs.job }, diagnostic: { artifact_id: "ARTIFACT-A", evidence_ref: refs.artifact },
      checks: [{ ...identity, check_id: "CHECK-A", evidence_ref: refs.check }] } } };
  const events = [];
  // Builds the provider-independent registry with observable audit events and isolated Git responses.
  const build = () => blockerRecoveryTools({ fileService: createFileService({ projectRoot: root }), projectRoot: root,
    profile: { role, agent_id: "AGENT-A" }, task_id: "TICKET-A", correlation_id: "CORR-A", job,
    projectLogger: (event) => events.push(event), gitService: {
      status: async () => "", diffPatchFrom: async () => ""
    } });
  return { root, refs, identity, artifact, job, events, build, cleanup: () => rm(root, { recursive: true, force: true }) };
}

for (const role of ["sprint_leader", "architecture_manager"]) {
  test(`${role} reads bound artifact, job and check with canonical tools and preserves Git discovery`, async () => {
    const f = await fixture(role);
    try {
      const tools = f.build();
      assert.equal(tools.registry.write_diff, undefined);
      for (const path of Object.values(f.refs)) {
        const result = await tools.registry.read_file.execute({ path, offset: 1, limit: 80 });
        const bytes = await readFile(join(f.root, path), "utf8");
        assert.equal(result.content, bytes);
        assert.equal(result.sha256, `sha256:${createHash("sha256").update(bytes).digest("hex")}`);
        const lines = await tools.registry.read_lines.execute({ path, start_line: 1, end_line: 80 });
        assert.equal(lines.stdout.trimEnd(), bytes.trimEnd());
        assert.equal(lines.sha256, result.sha256);
        const disposition = { action: "reconciliation_required", summary: "Baseline comparison needs further inspection.",
          guidance: "Compare failed assertion causes using the retained baseline receipt.", evidence: [{ path, sha256: result.sha256.slice(7) }] };
        const accepted = await validateBlockerDisposition(disposition, { job: f.job, projectRoot: f.root,
          fileService: createFileService({ projectRoot: f.root }) });
        assert.equal(accepted.action, "reconciliation_required");
      }
      assert.match((await tools.registry.read_file.execute({ path: f.refs.artifact, offset: 1, limit: 80 })).content,
        /baseline assertion evidence/);
      await tools.registry.read_file.execute({ path: "backend/source.js" });
      assert.equal((await tools.registry.git_diff.execute({})).exit_code, 0);
      assert.equal(f.events.filter((event) => event.status === "failed").length, 0);
    } finally { await f.cleanup(); }
  });
}

test("recovery denies other receipts, runtime state, traversal, unbound refs and other roles", async () => {
  const f = await fixture("sprint_leader");
  try {
    const tools = f.build();
    for (const path of [f.refs.artifact.replace("TICKET-A", "TICKET-B"), f.refs.artifact.replace("ARTIFACT-A", "ARTIFACT-B"),
      ".forge/runtime/agent-checkpoints/TICKET-A.json", ".forge/runtime/ticket-verification/TICKET-A/artifacts/../jobs/VERIFY-A.json"]) {
      await assert.rejects(() => tools.registry.read_file.execute({ path, offset: 1, limit: 80 }), { code: "FILE_ROLE_FORBIDDEN" });
      assert.equal(f.events.at(-1).payload.path, path.includes("/../") ? undefined : path);
    }
    f.job.ticket_progress.verification.diagnostic.evidence_ref = ".forge/runtime/private.json";
    await assert.rejects(() => f.build().registry.read_file.execute({ path: ".forge/runtime/private.json" }), { code: "FILE_ROLE_FORBIDDEN" });
    f.job.ticket_progress.verification.status = "missing";
    await assert.rejects(() => f.build().registry.read_file.execute({ path: f.refs.job }), { code: "FILE_ROLE_FORBIDDEN" });
  } finally { await f.cleanup(); }
  const coder = await fixture("coder");
  try {
    await assert.rejects(() => coder.build().registry.read_file.execute({ path: coder.refs.artifact }), { code: "FILE_ROLE_FORBIDDEN" });
  } finally { await coder.cleanup(); }
});

test("SL can submit a resolved handoff citing the same receipt read by its tools", async () => {
  const f = await fixture("sprint_leader");
  try {
    const result = await f.build().registry.read_file.execute({ path: f.refs.artifact, offset: 1, limit: 80 });
    const disposition = { action: "resolved", summary: "The retained receipt identifies the remaining verification work.",
      authority_quote: f.job.request.ticket.objective, guidance: "Resume the retained checkpoint to complete the approved verification.",
      evidence: [{ path: f.refs.artifact, sha256: result.sha256.slice(7) }] };
    const options = { job: f.job, plan: {}, projectRoot: f.root, fileService: createFileService({ projectRoot: f.root }) };
    assert.equal((await validateBlockerDisposition(disposition, options)).action, "resolved");
    await assert.rejects(() => validateBlockerDisposition({ ...disposition,
      evidence: [{ path: f.refs.artifact, sha256: "0".repeat(64) }] }, options),
    (error) => error.validation_errors?.[0].reason === "evidence_stale");
    await writeFile(join(f.root, f.refs.artifact), JSON.stringify({ ...f.artifact, project_id: "PROJECT-B" }));
    await assert.rejects(() => validateBlockerDisposition(disposition, options), { code: "VERIFY_SOURCE_STALE" });
    f.job.ticket_progress.verification.status = "missing";
    await assert.rejects(() => validateBlockerDisposition(disposition, options), { code: "FILE_ROLE_FORBIDDEN" });
  } finally { await f.cleanup(); }
});

test("recovery rejects replaced receipt identities and symlink targets", async () => {
  const f = await fixture("sprint_leader");
  try {
    const tools = f.build();
    for (const delta of [{ project_id: "PROJECT-B" }, { task_id: "TICKET-B" }, { commit_sha: "d".repeat(40) },
      { source_revision: "different" }, { artifact_id: "ARTIFACT-B" }]) {
      await writeFile(join(f.root, f.refs.artifact), JSON.stringify({ ...f.artifact, ...delta }));
      await assert.rejects(() => tools.registry.read_file.execute({ path: f.refs.artifact, offset: 1, limit: 80 }), { code: "VERIFY_SOURCE_STALE" });
    }
    await rm(join(f.root, f.refs.artifact));
    await symlink(join(f.root, f.refs.job), join(f.root, f.refs.artifact));
    await assert.rejects(() => tools.registry.read_lines.execute({ path: f.refs.artifact, start_line: 1, end_line: 10 }), { code: "FILE_ROLE_FORBIDDEN" });
  } finally { await f.cleanup(); }
});

for (const role of ["sprint_leader", "architecture_manager"]) {
  test(`${role} reads an exact pre-commit check without a verification job, but never treats it as committed acceptance`, async () => {
    const f = await fixture(role);
    try {
      const verification = f.job.ticket_progress.verification;
      Object.assign(verification, { status: "missing", commit_sha: null, job: null, diagnostic: null });
      verification.checks[0].commit_sha = null;
      const receipt = { ...f.identity, check_id: "CHECK-A", commit_sha: null, pre_commit: true, stdout: "41 focused tests passed" };
      await writeFile(join(f.root, f.refs.check), JSON.stringify(receipt, null, 2));
      const tools = f.build();
      const result = await tools.registry.read_file.execute({ path: f.refs.check, offset: 1, limit: 80 });
      assert.match(result.content, /41 focused tests passed/);
      assert.match((await tools.registry.read_lines.execute({ path: f.refs.check, start_line: 1, end_line: 80 })).stdout, /41 focused tests passed/);
      const disposition = { action: "reconciliation_required", summary: "Inspect the focused pre-commit check.",
        guidance: "Continue verification; this pre-commit check is diagnostic evidence only.", evidence: [{ path: f.refs.check, sha256: result.sha256.slice(7) }] };
      assert.equal((await validateBlockerDisposition(disposition, { job: f.job, projectRoot: f.root,
        fileService: createFileService({ projectRoot: f.root }) })).action, "reconciliation_required");
      for (const path of [f.refs.job, f.refs.artifact, f.refs.check.replace("TICKET-A", "TICKET-B"), ".forge/runtime/agent-checkpoints/TICKET-A.json"])
        await assert.rejects(() => tools.registry.read_file.execute({ path }), { code: "FILE_ROLE_FORBIDDEN" });
      for (const delta of [{ pre_commit: false }, { source_revision: "other" }, { commit_sha: "c".repeat(40) }, { task_id: "OTHER" }, { project_id: "OTHER" }]) {
        await writeFile(join(f.root, f.refs.check), JSON.stringify({ ...receipt, ...delta }));
        await assert.rejects(() => tools.registry.read_file.execute({ path: f.refs.check, offset: 1, limit: 80 }), { code: "VERIFY_SOURCE_STALE" });
      }
      await writeFile(join(f.root, f.refs.check), JSON.stringify(receipt));
      verification.status = "unavailable";
      await assert.rejects(() => f.build().registry.read_file.execute({ path: f.refs.check }), { code: "FILE_ROLE_FORBIDDEN" });
    } finally { await f.cleanup(); }
  });
}

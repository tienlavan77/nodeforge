// Exercises dependency evidence across agent reads, Architecture validation and checkpoint recovery.
// Real pnpm-style links must remain read-only and project-local while their current bytes are checksum validated.
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createRoleFileService } from "../../src/infrastructure/filesystem/file-service-role-policy.js";
import { createReadFileTool, createWriteDiffTool, createEditDiffTool } from "../../src/tools/agent-lifecycle-tools.js";
import { createOwnerDeleteFileTool } from "../../src/tools/owner-delete-file.js";
import { validateBlockerDisposition, assertDeclaredContractEvidence } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

// Installs a small guide through the same workspace-to-shared-store link shape used by pnpm.
async function installGuide(root) {
  const canonical = "node_modules/.pnpm/next@1.0.0/node_modules/next/dist/docs/guide.md";
  await mkdir(join(root, canonical, ".."), { recursive: true });
  await writeFile(join(root, canonical), "# Guide\nUse Client Components for interactive controls.\n");
  for (const directory of ["backend", "ui/nextjs"]) {
    await mkdir(join(root, directory, "node_modules"), { recursive: true });
    await symlink(join(root, "node_modules/.pnpm/next@1.0.0/node_modules/next"), join(root, directory, "node_modules/next"));
  }
  return { canonical, path: "ui/nextjs/node_modules/next/dist/docs/guide.md" };
}

// Creates isolated package and project roots so rejected reads cannot touch the developer's actual dependencies.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-blocker-dependency-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const guide = await installGuide(root);
  const files = createFileService({ projectRoot: root });
  const options = { projectRoot: root, fileService: files, job: { stage: "sprint_leader", request: { task_id: "TASK", project_id: "P" } } };
  return { root, guide, files, options };
}

// Builds a source-bound consultation whose checksum is supplied by an actual Forge read rather than invented evidence.
function consultation(file) {
  return { action: "architecture_required", summary: "Resolve the installed framework guidance prerequisite.",
    evidence: [{ path: file.path, sha256: file.sha256.replace(/^sha256:/, "") }] };
}

test("agent dependency reads and evidence validation agree without weakening the normal FileService boundary", async t => {
  const f = await fixture(t);
  await assert.rejects(f.files.readFile({ path: f.guide.path }), { code: "CONFIGURATION_ERROR" });
  for (const role of ["coder", "reviewer", "sprint_leader", "architecture_manager", "system_engineer"]) {
    const scoped = createRoleFileService({ fileService: f.files, projectRoot: f.root, role });
    const tool = createReadFileTool({ fileService: scoped, projectRoot: f.root });
    const file = await tool.execute({ path: f.guide.path }, { task_id: "TASK", agent_identity: { role }, allowed_prefixes: ["ui/nextjs"] });
    const value = consultation(file);
    assert.equal((await validateBlockerDisposition(value, f.options)).action, "architecture_required");
    const quote = "Use installed framework guidance within the approved project boundary.";
    const ref = { ...value.evidence[0], authority_quote: quote };
    await assertDeclaredContractEvidence(ref, { fileService: f.files, projectRoot: f.root,
      plan: {}, architecture: { markdown: quote }, ticket: { execution_policy: { contract_evidence: [ref] } } });
  }
});

test("dependency evidence rejects stale checksums, protected files, external targets and oversized guides", async t => {
  const f = await fixture(t);
  const scoped = createRoleFileService({ fileService: f.files, projectRoot: f.root, role: "architecture_manager" });
  const value = consultation(await scoped.readForIndex({ path: f.guide.path }));
  await writeFile(join(f.root, f.guide.canonical), "# Guide changed\n");
  await assert.rejects(validateBlockerDisposition(value, f.options), error => error.validation_errors[0].reason === "evidence_stale");
  for (const path of ["ui/nextjs/node_modules/next/.env", "ui/nextjs/node_modules/next/../next/dist/docs/guide.md"]) {
    await assert.rejects(validateBlockerDisposition({ ...value, evidence: [{ ...value.evidence[0], path }] }, f.options), { code: "FILE_ROLE_FORBIDDEN" });
  }
  const outside = await mkdtemp(join(tmpdir(), "nf-external-guide-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(join(outside, "guide.md"), "External guide\n");
  await symlink(outside, join(f.root, "ui/nextjs/node_modules/external"));
  const externalPath = "ui/nextjs/node_modules/external/guide.md";
  await assert.rejects(validateBlockerDisposition({ ...value, evidence: [{ ...value.evidence[0], path: externalPath }] }, f.options), { code: "FILE_ROLE_FORBIDDEN" });
  const content = "x".repeat(1_000_001);
  await writeFile(join(f.root, f.guide.canonical), content);
  const sha256 = createHash("sha256").update(content).digest("hex");
  await assert.rejects(validateBlockerDisposition({ ...value, evidence: [{ path: f.guide.path, sha256 }] }, f.options), { code: "FILE_TOO_LARGE" });
});

test("every role can read dependencies but cannot overwrite, edit, create or delete their contents", async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, f.guide.canonical), "utf8");
  for (const role of ["coder", "reviewer", "sprint_leader", "architecture_manager", "system_engineer"]) {
    const scoped = createRoleFileService({ fileService: f.files, projectRoot: f.root, role });
    const file = await scoped.readForIndex({ path: f.guide.path });
    const context = { task_id: "TASK", agent_identity: { role }, allowed_prefixes: ["backend", "ui", "node_modules"] };
    for (const path of [f.guide.path, f.guide.canonical, "backend/node_modules/next/dist/docs/guide.md"]) {
      await assert.rejects(scoped.atomicWrite({ path, content: "Changed", replace: true }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(scoped.atomicWrite({ path: `${path}.new`, content: "Created" }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(scoped.deleteFile({ path }), { code: "FILE_ROLE_FORBIDDEN" });
      await assert.rejects(createWriteDiffTool({ fileService: f.files }).execute({ path, content: "Changed", before_checksum: file.sha256 }, context), { code: "PATH_FORBIDDEN" });
      await assert.rejects(createEditDiffTool({ fileService: f.files }).execute({ path, anchor: "Guide", replacement: "Changed", before_checksum: file.sha256 }, context), { code: "PATH_FORBIDDEN" });
      await assert.rejects(createOwnerDeleteFileTool({ fileService: scoped }).execute({ path, before_checksum: file.sha256 }, context), { code: "FILE_ROLE_FORBIDDEN" });
    }
  }
  assert.equal(await readFile(join(f.root, f.guide.canonical), "utf8"), before);
});

test("AM package evidence survives restart and returns SL to the retained Coder without repeating AM discovery", async () => {
  let evidence;
  const f = await blockerRecoveryFixture({ investigate: async (job, resolution) =>
    job.stage === "sprint_leader" && !job.architecture_response
      ? { action: "architecture_required", summary: "Resolve installed package guidance." }
      : { ...resolution, evidence: [...resolution.evidence, evidence] } });
  try {
    const root = f.base.workspace.projectRoot;
    const guide = await installGuide(root);
    const scoped = createRoleFileService({ fileService: f.base.fileService, projectRoot: root, role: "architecture_manager" });
    evidence = consultation(await scoped.readForIndex({ path: guide.path })).evidence[0];
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    await f.recovery.tick(); await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].architecture_response.disposition.action, "resolved");
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.base.checkpoints.save({ ...checkpoint, thread_id: "RETAINED", last_completed_turn: 17 });
    await f.recreate().tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
    assert.equal((await f.base.checkpoints.load("TASK")).last_completed_turn, 17);
    assert.equal(f.base.invocations, 2);
    assert.equal(f.base.integrations, 1);
  } finally { await f.close(); }
});

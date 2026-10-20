// Verifies failed review JSON resumes its independent SDK session only for the same immutable source identity.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { createReviewWorker } from "../../src/modules/supervisor/review-worker.js";
import { createTicketReviewFindingsStore } from "../../src/modules/supervisor/ticket-review-findings.js";

// Supplies real committed source, a durable failed response and an independent Reviewer without calling a provider.
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nf-review-verdict-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const content = "// Supplies routing.\nexport const selected = true;\n", path = "src/router.js";
  await mkdir(join(root, "src"));
  await writeFile(join(root, path), content);
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init"); git("add", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture");
  const commit = git("rev-parse", "HEAD");
  const artifact = { status: "passed", project_id: "P", artifact_id: "A", commit_sha: commit, base_sha: commit,
    source_revision: "S", manifest_sha: "M", changed_paths: [path], file_checksums: { [path]: `sha256:${createHash("sha256").update(content).digest("hex")}` } };
  const context = { state: "reviewing", version: 1, project_id: "P", task_id: "T", review_commit_sha: commit, base_sha: commit,
    verification_artifact_id: "A", source_revision: "S", manifest_sha: "M", manifest_paths: [path] };
  const prior = { task_id: "T", status: "failed", reviewer_id: "R", provider: "codex", commit, verification: artifact,
    thread_id: "REVIEW-THREAD", last_completed_turn: 15, completed_tools: ["read_lines"], turn_history: [{ turn: 15, tool: "read_lines", target: path, outcome: "ok" }],
    last_error: { code: "REVIEW_VERDICT_INVALID" }, verdict_attempts: [{ status: "invalid", response_text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [{ finding_id: "T-R1", decision: "fixed", reason: "Inspected", evidence_refs: [path] }] }) }] };
  const requests = [], saved = [];
  const reviewFindings = { load: async () => ({ findings: [], coder_reports: [{ artifact_id: "A", report: { summary: "Implemented" } }] }) };
  const reviewer = { agent_id: "R", provider: "codex" };
  let result = { text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [] }) };
  const worker = createReviewWorker({ projectRoot: root, fileService: createFileService({ projectRoot: root }),
    rulesFileService: { readForIndex: async () => ({ content: "Read independently and return JSON." }) },
    agentResolver: { resolveAvailable: () => reviewer },
    codexSdkGateway: { execute: async (request) => { requests.push(request); return result; } },
    gitService: { getHead: async () => commit }, executionContexts: { load: async () => context },
    verificationService: { assertPassedArtifact: async () => artifact, assertCleanWorktree: async () => {} },
    reviewFindings,
    checkpoints: { loadReview: async () => prior, saveReview: async (checkpoint) => { saved.push(structuredClone(checkpoint)); return checkpoint; } } });
  return { worker, prior, requests, saved, root, path, context, artifact, reviewFindings, setResponse: (response) => { result = response; },
    job: { task_id: "T", agent_id: "C", request_id: "REQ", correlation_id: "CORR", payload: { ticket: {}, verification: artifact, execution_context: context, changed_paths: [path] } } };
}

test("same-source failed verdict resumes its recorded Reviewer session and preserves completed discovery turns", async (t) => {
  const f = await fixture(t);
  const result = await f.worker.review(f.job);
  assert.equal(f.requests.length, 1);
  assert.match(f.requests[0].prompt, /^NODE REVIEW FORMAT CORRECTION/);
  assert.equal(f.requests[0].resumeThreadId, "REVIEW-THREAD");
  assert.deepEqual(f.requests[0].options.forgeTools.definitions, []);
  assert.equal(result.last_completed_turn, 15);
  assert.equal(result.verdict, "approved");
  assert.equal(f.saved.at(-1).verdict_attempts[0].response_text, f.prior.verdict_attempts[0].response_text);
});

test("legacy failed reopening resumes the retained verdict with real store validation and no repeated SDK discovery", async (t) => {
  const f = await fixture(t);
  const store = createTicketReviewFindingsStore({ taskId: "T", fileService: createFileService({ projectRoot: f.root }), executionContexts: { load: async () => f.context } });
  const binding = { artifactId: "A", commitSha: f.artifact.commit_sha, sourceRevision: "S", reviewerId: "R" };
  const finding = { acceptance_criterion: "AC-1", failure: "Runtime root needs containment", minimum_change_scope: "Reject linked ancestors", evidence_refs: [f.path] };
  await store.recordReview({ ...binding, verdict: "request_changes", findings: [finding] });
  await store.recordReview({ ...binding, verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed", reason: "Initially judged repaired", evidence_refs: [f.path] }] });
  await store.recordCoderReport({ report: { summary: "Implemented" }, artifact: f.artifact, idempotencyKey: "REPORT" });
  Object.assign(f.reviewFindings, { load: store.load, validateReview: store.validateReview });
  const before = await store.load();
  const response = { verdict: "request_changes", findings: [{ ...finding, finding_id: "REV-1", failure: "An existing nested root still redirects storage" }],
    adjudications: [{ finding_id: "REV-1", decision: "refine", reason: "Current evidence shows a remaining case", evidence_refs: [f.path] }] };
  f.prior.last_error = { code: "REVIEW_FINDINGS_INVALID", message: "A closed finding cannot be reopened" };
  f.prior.verdict_attempts = [{ status: "valid", response_text: JSON.stringify(response) }];
  const result = await f.worker.review(f.job);
  assert.equal(f.requests.length, 0, "retained evidence should not trigger another SDK request");
  assert.equal(result.last_completed_turn, 15);
  assert.deepEqual(result.adjudications, response.adjudications);
  assert.deepEqual(await store.load(), before, "worker validation must not publish a verdict prematurely");
  await store.recordReview({ ...binding, ...result });
  assert.equal((await store.unresolved())[0].finding_id, "REV-1");
});

test("changed artifact, project, task or Reviewer cannot reuse a prior invalid response", async (t) => {
  for (const kind of ["artifact", "project", "task", "reviewer"]) {
    const f = await fixture(t);
    if (kind === "artifact") f.prior.verification = { ...f.prior.verification, artifact_id: "FOREIGN" };
    if (kind === "project") f.prior.verification = { ...f.prior.verification, project_id: "FOREIGN" };
    if (kind === "task") f.prior.task_id = "FOREIGN";
    if (kind === "reviewer") f.prior.reviewer_id = "FOREIGN";
    await f.worker.review(f.job);
    assert.doesNotMatch(f.requests[0].prompt, /^NODE REVIEW FORMAT CORRECTION/);
    assert.equal(f.requests[0].resumeThreadId, undefined);
  }
});

test("source checksum drift blocks retained response recovery before any Reviewer call", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, f.path), "changed source\n");
  await assert.rejects(f.worker.review(f.job), { code: "REVIEW_SOURCE_MISMATCH" });
  assert.equal(f.requests.length, 0);
});

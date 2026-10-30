/** Checks real committed review verification, durable idempotence, baseline
 * attribution and interruption without modifying reports, live code or Git refs. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { reviewVerificationFixture } from "../fixtures/review-verification-fixture.js";
import { createReviewVerificationService } from "../../src/modules/supervisor/review/review-verification-service.js";
import { createReviewWorker } from "../../src/modules/supervisor/review/review-worker.js";
import { createCommittedReviewSource } from "../../src/modules/supervisor/review/reviewer-committed-source.js";
import { createAutomaticReviewWorkerResolver } from "../../src/modules/supervisor/review/automatic-review-source.js";
import { createExecutionEventBus } from "../../src/modules/supervisor/execution-event-bus.js";

// Reviewer intent must reach Node with the original commit and dependencies;
// changing runner requirements must not reuse a different environment's receipt.
test("Reviewer runner request is delivered exactly and separates receipt identities", async () => {
  const f = await reviewVerificationFixture();
  try {
    const commands = [];
    const service = createReviewVerificationService({ ...f.options, runCommand: async input => {
      commands.push(input);
      return { ...await f.options.runCommand(input), runtime_environment: { type: input.environment, receipt_path: "/namespace/receipt.json" } };
    } });
    const input = { artifact: f.artifact, executionId: "EXECUTION-1" };
    const [namespace] = await service({ ...input, requests: [{ ...f.request, environment: "filesystem_namespace" }] });
    const [ordinary] = await service({ ...input, requests: [{ ...f.request, environment: "project" }] });
    assert.equal(commands[0].environment, "filesystem_namespace"); assert.equal(commands[0].projectRoot, f.root);
    assert.equal(commands[1].environment, "project");
    assert.notEqual(namespace.check_id, ordinary.check_id);
    assert.equal(namespace.commit_sha, f.artifact.commit_sha); assert.deepEqual(namespace.environment, f.artifact.environment);
    assert.equal(namespace.commands[0].runtime_environment.type, "filesystem_namespace");
    await assert.rejects(service({ ...input, requests: [{ ...f.request, environment: "privileged_shell" }] }), { code: "REVIEW_VERDICT_INVALID" });
    assert.equal(commands.length, 2);
  } finally { await f.close(); }
});

test("review checks use the recorded commit/environment and reuse receipts across duplicates and restart", async () => {
  const f = await reviewVerificationFixture();
  try {
    const index = await readFile(join(f.root, ".git/index"));
    const input = { requests: [f.request], artifact: f.artifact, executionId: "EXECUTION-1" };
    const [first, concurrent] = await Promise.all([f.service(input), f.service(input)]);
    assert.equal(f.commands(), 1);
    assert.equal(first[0].status, "passed"); assert.equal(first[0].pre_commit, false);
    assert.equal(first[0].commit_sha, f.artifact.commit_sha); assert.deepEqual(first[0].environment, f.artifact.environment);
    assert.equal(first[0].check_id, concurrent[0].check_id);
    const restarted = createReviewVerificationService(f.options);
    const again = await restarted({ ...input, requests: [{ ...f.request, reason: "Same check with different prose." }] });
    assert.equal(again[0].check_id, first[0].check_id); assert.equal(f.commands(), 1);
    assert.deepEqual(await readFile(join(f.root, ".git/index")), index);
    assert.equal((await f.git.run(["rev-parse", "HEAD"])).trim(), f.artifact.commit_sha);
    assert.match(await readFile(join(f.root, f.path), "utf8"), /Live source must not run/);
    assert.equal(f.artifact.status, "passed");
    assert.deepEqual(f.logs.map((event) => event.event_name), ["review.verification_started", "review.verification_passed"]);
  } finally { await f.close(); }
});

test("wrong identities, absent tests and unsupported selectors never execute a command", async () => {
  const f = await reviewVerificationFixture();
  try {
    const input = { requests: [f.request], artifact: f.artifact, executionId: "EXECUTION-1" };
    for (const patch of [{ commit_sha: "a".repeat(40) }, { source_revision: "other" }, { artifact_id: "ARTIFACT-OTHER" },
      { test_paths: ["backend/tests/../secrets.test.mjs"] }, { command: "node --test" }, { test_paths: ["backend/tests/*.test.mjs"] }]) {
      await assert.rejects(f.service({ ...input, requests: [{ ...f.request, ...patch }] }), { code: "REVIEW_VERDICT_INVALID" });
    }
    await assert.rejects(f.service({ ...input, artifact: { ...f.artifact, project_id: "OTHER" } }), { code: "REVIEW_VERIFICATION_SCOPE" });
    await assert.rejects(f.service({ ...input, requests: [{ ...f.request, test_paths: ["backend/tests/absent.test.mjs"] }] }), { code: "REVIEW_VERIFICATION_TEST_UNAVAILABLE" });
    await assert.rejects(f.service({ ...input, artifact: { ...f.artifact, environment: null } }), { code: "REVIEW_VERIFICATION_ENVIRONMENT_REQUIRED" });
    assert.equal(f.commands(), 0);
  } finally { await f.close(); }
});

test("an interrupted read-only check resumes from persisted intent and publishes one terminal receipt", async () => {
  const f = await reviewVerificationFixture();
  try {
    const input = { requests: [f.request], artifact: f.artifact, executionId: "EXECUTION-1" };
    const interrupted = createReviewVerificationService({ ...f.options, runCommand: async () => { throw Object.assign(new Error("Connection interrupted"), { code: "ECONNRESET" }); } });
    await assert.rejects(interrupted(input), { code: "ECONNRESET" });
    const folder = join(f.root, ".forge/runtime/ticket-verification/TICKET-REVIEW/review-checks");
    const files = await readdir(folder);
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(await readFile(join(folder, files[0]), "utf8")).status, "running");
    const result = await createReviewVerificationService(f.options)(input);
    assert.equal(result[0].status, "passed"); assert.equal(f.commands(), 1);
    assert.equal((await readdir(folder)).length, 1);
  } finally { await f.close(); }
});

test("Stop interrupts the Node check and prevents a successful receipt until explicit resume", async () => {
  const f = await reviewVerificationFixture();
  try {
    const controller = new AbortController();
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    const run = createReviewVerificationService({ ...f.options, runCommand: ({ signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true }); started();
    }) });
    const input = { requests: [f.request], artifact: f.artifact, executionId: "EXECUTION-1" };
    const result = run({ ...input, signal: controller.signal });
    await began;
    controller.abort(Object.assign(new Error("Ticket stopped by owner"), { code: "TICKET_STOPPED" }));
    await assert.rejects(result, { code: "TICKET_STOPPED" });
    assert.ok(!f.logs.some((event) => event.event_name === "review.verification_passed"));
    assert.equal((await f.service(input))[0].status, "passed");
  } finally { await f.close(); }
});

test("supplemental failures are compared with the same recorded baseline before attribution", async () => {
  const f = await reviewVerificationFixture({ failing: true });
  try {
    const [receipt] = await f.service({ requests: [{ ...f.request, scope: "regression" }], artifact: f.artifact, executionId: "EXECUTION-1" });
    assert.equal(f.commands(), 2);
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.commands[0].exit_code, 1);
    assert.equal(receipt.commands[0].disposition, "preexisting_failure");
    assert.equal(receipt.commands[0].baseline.commit_sha, f.artifact.base_sha);
    assert.equal(receipt.commands[0].baseline.environment_sha256, f.artifact.environment.sha256);
  } finally { await f.close(); }
});

test("the real Review Worker awaits Node checks and returns their exact evidence to Reviewer", async () => {
  const f = await reviewVerificationFixture();
  try {
    const context = { task_id: f.artifact.task_id, state: "verified", version: 1, verification_artifact_id: f.artifact.artifact_id,
      review_commit_sha: f.artifact.commit_sha, source_revision: f.artifact.source_revision, manifest_sha: f.artifact.manifest_sha,
      base_sha: f.artifact.base_sha, manifest_paths: [f.path] };
    const checkpoints = [];
    let invocations = 0;
    let validated = 0;
    const worker = createReviewWorker({ projectRoot: f.root,
      fileService: createCommittedReviewSource({ projectRoot: f.root, commit: f.artifact.commit_sha, baseCommit: f.artifact.base_sha }),
      gitService: { rootOnly: true, getHead: async () => f.artifact.commit_sha },
      executionContexts: { load: async () => context, update: async (_id, _version, patch) => Object.assign(context, patch) },
      verificationService: { assertPassedArtifact: async () => f.artifact, runReviewVerification: f.service },
      rulesFileService: { readForIndex: async () => ({ content: "Review exact source and explicitly request missing verification." }) },
      reviewFindings: { load: async () => ({ findings: [{ finding_id: "REV-1", status: "open" }], coder_reports: [
        { artifact_id: f.artifact.artifact_id, review_commit_sha: f.artifact.commit_sha, report: { summary: "Source is complete." } }] }),
      validateReview: async (value) => { validated++; assert.equal(value.verdict, "approved"); } },
      checkpoints: { saveReview: async (value) => { checkpoints.push(structuredClone(value)); } },
      agentResolver: { resolveAvailable: () => ({ agent_id: "REVIEWER", provider: "openai" }) },
      openaiSdkGateway: { execute: async ({ prompt, options }) => {
        invocations++;
        if (invocations === 1) return { text: JSON.stringify({ verdict: "verification_required", findings: [], adjudications: [], verification_requests: [f.request] }) };
        assert.equal(invocations, 2); assert.equal(f.commands(), 1);
        assert.match(prompt, /NODE REVIEW VERIFICATION RESULTS/);
        const path = prompt.match(/"path":"([^"]+\/verification\/CHECK-[^"]+\.json)"/)[1];
        const output = await options.forgeTools.registry.read_lines.execute({ path, start_line: 1, end_line: 25 });
        assert.ok(output.stdout.includes(f.artifact.commit_sha));
        return { text: JSON.stringify({ verdict: "approved", findings: [], adjudications: [{ finding_id: "REV-1", decision: "fixed",
          reason: "Node has supplied the exact requested security receipt.", evidence_refs: [path] }] }) };
      } }
    });
    const result = await worker.review({ task_id: f.artifact.task_id, agent_id: "CODER", payload: {
      execution_id: "EXECUTION-1", ticket: { id: f.artifact.task_id, acceptance_criteria: ["Current security checks pass"] } } });
    assert.equal(result.verdict, "approved"); assert.equal(validated, 1);
    assert.ok(checkpoints.some((entry) => entry.review_verification?.status === "running"));
    assert.equal(checkpoints.at(-1).review_verification.status, "completed");
    assert.equal(f.artifact.commit_sha, context.review_commit_sha);
  } finally { await f.close(); }
});

test("automatic review Stop cancels a pending Node check before another SDK call", async () => {
  const f = await reviewVerificationFixture();
  try {
    let started;
    const began = new Promise((resolve) => { started = resolve; });
    let sdkCalls = 0;
    let released = false;
    const context = { task_id: f.artifact.task_id, state: "reviewing", version: 1, verification_artifact_id: f.artifact.artifact_id,
      review_commit_sha: f.artifact.commit_sha, source_revision: f.artifact.source_revision, manifest_sha: f.artifact.manifest_sha,
      base_sha: f.artifact.base_sha, manifest_paths: [f.path] };
    const reviewer = { agent_id: "REVIEWER", provider: "openai", enabled: true, status: "ready" };
    const eventBus = createExecutionEventBus();
    const current = { project_id: f.artifact.project_id, status: "reviewing", details: { execution_id: "EXECUTION-1" } };
    const source = createCommittedReviewSource({ projectRoot: f.root, commit: f.artifact.commit_sha, baseCommit: f.artifact.base_sha });
    const resolve = createAutomaticReviewWorkerResolver({ eventBus, ticketStatusStore: { get: () => current },
      agentResolver: { resolveAvailable: () => reviewer, list: () => [reviewer] },
      agentOccupancy: { claim: async () => ({ claim_id: "CLAIM-1" }), release: async () => { released = true; } },
      resolveTicketWorkspace: async () => ({ path: f.root, worktreeFileService: source, gitService: { rootOnly: true, getHead: async () => f.artifact.commit_sha },
        executionContexts: { load: async () => context }, reviewFindings: { load: async () => ({ findings: [{ finding_id: "REV-1" }], coder_reports: [{ artifact_id: f.artifact.artifact_id }] }) },
        testService: { assertPassedArtifact: async () => f.artifact, runReviewVerification: ({ signal }) => new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }); started();
        }) } }),
      gateways: { openaiSdkGateway: { execute: async () => {
        sdkCalls++;
        return { text: JSON.stringify({ kind: "review_result", subject: "Need security evidence.", evidence: [], payload: { verdict: "verification_required",
          summary: "Run the missing check.", findings: [], finding_updates: [], verification_requests: [f.request] } }) };
      } } }
    });
    const job = { task_id: f.artifact.task_id, project_id: f.artifact.project_id, supervisor_id: "SUP-REVIEW", request_id: "REQ-REVIEW", agent_id: "CODER",
      review_rules: "Use explicit verification requests.", review_policy: { gate: "on" }, payload: { execution_id: "EXECUTION-1", ticket: {
        id: f.artifact.task_id, project_id: f.artifact.project_id, acceptance_criteria: ["Security tests pass"] } } };
    const result = (await resolve(job)).review();
    await began;
    current.status = "failed"; current.details.reason = "TICKET_STOPPED";
    await eventBus.publish({ type: "task.failed", task_id: job.task_id, supervisor_id: job.supervisor_id,
      payload: { execution_id: "EXECUTION-1", reason: "TICKET_STOPPED" } });
    await assert.rejects(result, { code: "TICKET_STOPPED" });
    assert.equal(sdkCalls, 1); assert.equal(released, true);
  } finally { await f.close(); }
});

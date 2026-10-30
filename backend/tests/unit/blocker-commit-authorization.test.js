// Verifies renewed owner consent returns ticket implementation to Coder without bypassing denial, scope or checkpoint gates.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { hasBlockerCommitAuthorization } from "../../src/modules/supervisor/blocker/blocker-commit-authorization.js";
import { requiresBlockerAdmission } from "../../src/modules/supervisor/blocker/blocker-failure-classification.js";
import { buildResumePrompt, createResumeState } from "../../src/modules/supervisor/ticket/ticket-resume.js";
import { buildCodexTicketPrompt, buildToolTicketPrompt } from "../../src/modules/supervisor/nodeforge-task-prompts.js";
import { routeTicketRun } from "../../src/transport/http/forge-v1-ticket-run-route.js";
import { createTicketRunDispatch } from "../../src/application/ticket-run-dispatch.js";

// Provides the original commit denial and a real durable recovery pipeline, with the next Coder invocation simulated.
async function fixture(tool = "commit_changes") {
  return blockerRecoveryFixture({ reason: "ACCESS_REQUIRED", recoveryOptions: { readFailureEvidence: async () => ({ status: "captured", receipts: [
    { event_id: "COMMIT-DENIAL", tool, error: { code: "APPROVAL_DENIED", message: "This action was rejected due to unacceptable risk. Do not commit unless explicitly asked; no such owner authorization is present." } }
  ] }) }, investigate: async (job, resolution) => hasBlockerCommitAuthorization(job) ? { ...resolution, technical_result: {
    findings: ["The authenticated owner explicitly requested this ticket's commit after repair."],
    implementation_steps: ["Resume Coder, repair the remaining finding, run focused checks, then commit ticket changes."],
    verification_steps: ["Run final committed verification, then continue independent Reviewer review."],
    admission: { status: "within_existing_permissions", rationale: "Owner consent is recorded; actual tool approval still runs." }
  } } : { action: "reconciliation_required", summary: "Commit lacks an explicit owner request.", guidance: "Retain Coder edits until the owner supplies commit consent.", evidence: resolution.evidence,
    reconciliation: { kind: "execution_admission", prerequisite: "Explicit owner commit request.", completed_checks: ["Read original denied commit receipts."], next_check: "Consume authenticated owner instruction.", waiting_for: [{ owner: "external", operation: "execute", question: "Owner must explicitly request the ticket commit." }] } } });
}

test("owner commit consent survives restart and SL hands implementation to the same Coder checkpoint without demanding a future commit", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const original = await f.base.checkpoints.load("TASK");
    await f.recovery.tick(); await f.recovery.tick();
    const blocked = (await f.ledger()).jobs[0];
    assert.equal(requiresBlockerAdmission(blocked), true);
    const result = await f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK", commitAuthorization: {
      actor: "OWNER", request_sha256: blocked.execution_admission.sha256, reason: "Coder must repair this ticket, test and commit its changed files, then continue review."
    } });
    assert.equal(result.resumed_stage, "sprint_leader");
    assert.equal(f.base.invocations, 1);
    const authorized = (await f.ledger()).jobs[0];
    assert.equal(hasBlockerCommitAuthorization(authorized), true);
    assert.equal(requiresBlockerAdmission(authorized), false);
    assert.equal(authorized.execution_admission.receipts[0].event_id, "COMMIT-DENIAL");
    assert.equal(hasBlockerCommitAuthorization({ ...authorized, request: { ...authorized.request, payload: { execution_id: "OTHER" } } }), false);
    f.recreate();
    await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "sprint_leader"]);
    assert.equal(f.base.invocations, 2);
    assert.equal(f.base.statusStore.get().details.execution_id, "EXEC");
    const checkpoint = await f.base.checkpoints.load("TASK");
    assert(checkpoint.last_completed_turn >= (original.last_completed_turn ?? 0));
    assert.equal(checkpoint.blocker_recovery.execution_admission.decision.operation, "commit_changes");
    const prompt = buildResumePrompt("TICKET", createResumeState({ ...checkpoint, status: "in_progress" }));
    assert.match(prompt, /NODE RECORDED OWNER COMMIT INSTRUCTION/);
    assert.match(prompt, /does not waive the actual tool approval/);
    assert.match(prompt, /future commit.*not a prerequisite/);
  } finally { await f.close(); }
});

test("commit consent rejects stale SHA, unrelated denied operations and changed source without launching Coder", async () => {
  for (const scenario of ["stale", "other", "drift"]) {
    const f = await fixture(scenario === "other" ? "edit_diff" : "commit_changes");
    try {
      await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
      await f.recovery.tick(); await f.recovery.tick();
      const job = (await f.ledger()).jobs[0];
      if (scenario === "drift") await f.base.fileService.atomicWrite({ path: f.evidence.path, content: "new source", replace: true });
      await assert.rejects(f.recovery.resumeTicket({ projectId: "P", ticketId: "TASK", commitAuthorization: {
        actor: "OWNER", request_sha256: scenario === "stale" ? "0".repeat(64) : job.execution_admission.sha256, reason: "Commit ticket changes."
      } }), { code: scenario === "other" ? "COMMIT_AUTHORIZATION_SCOPE" : "EXECUTION_ADMISSION_IDENTITY_MISMATCH" });
      assert.equal(f.base.invocations, 1);
      assert.equal((await f.ledger()).jobs[0].status, "reconciliation_required");
    } finally { await f.close(); }
  }
});

test("all RUN aliases authenticate owner consent and cannot accept a caller-selected actor or fresh restart", async () => {
  const input = { method: "POST", projectId: "P", body: { commit_authorization: { request_sha256: "a".repeat(64), reason: "Resume Coder and commit ticket edits." } },
    url: new URL("http://localhost/forge/v1/tickets/T:run?project=P"), headers: { authorization: "Bearer fixture" },
    planOwnerAuth: { verify: (headers) => { assert.equal(headers.authorization, "Bearer fixture"); return "AUTHENTICATED-OWNER"; } } };
  for (const parts of [["tickets", "T:run"], ["projects", "P", "tickets", "T", "run"], ["projects", "P", "tickets", "T", "T:run"]]) {
    const result = await routeTicketRun({ ...input, parts, dispatchTicket: async (request) => {
      assert.equal(request.commitAuthorization.actor, "AUTHENTICATED-OWNER"); assert.equal(request.ticketId, "T"); return { status: "accepted" };
    } });
    assert.equal(result.status, 202);
  }
  const call = (overrides) => routeTicketRun({ ...input, parts: ["tickets", "T:run"], dispatchTicket: async () => assert.fail("Must not dispatch"), ...overrides });
  await assert.rejects(call({ planOwnerAuth: { verify: () => { throw Object.assign(new Error("Unauthorized"), { code: "PLAN_OWNER_UNAUTHORIZED" }); } } }), { code: "PLAN_OWNER_UNAUTHORIZED" });
  await assert.rejects(call({ body: { ...input.body, fresh: true } }), { code: "COMMIT_AUTHORIZATION_INPUT" });
  await assert.rejects(call({ body: { commit_authorization: { ...input.body.commit_authorization, actor: "FORGED" } } }), { code: "COMMIT_AUTHORIZATION_INPUT" });
});

test("RUN application forwards explicit consent to blocker recovery without clearing checkpoint or calling Coder directly", async () => {
  const ticket = { id: "T", project_id: "P", sprint_id: "S", title: "Repair", objective: "Repair", acceptance_criteria: ["Works"] };
  const checkpoint = { status: "blocked", last_completed_turn: 13, blocker_recovery: { status: "reconciliation_required" } };
  const authorization = { actor: "OWNER", request_sha256: "a".repeat(64), reason: "Commit ticket edits." };
  const dispatch = createTicketRunDispatch({ disposition: { get: async () => null }, intake: { open: async () => ({ ticket }) },
    sprintRegistry: { get: () => ({}), assertReady: async () => ({ plan: { content: { tickets: ["T"], ticket_specs: [ticket] } } }) },
    ticketStatusStore: { get: () => ({ status: "needs_human_review", project_id: "P", details: {} }) },
    checkpoints: { load: async () => checkpoint, clear: () => assert.fail("Keep checkpoint") },
    coderRecovery: { resumeTicket: () => assert.fail("Do not bypass blocker coordinator") },
    blockerRecovery: { hasPending: async () => false, resumeTicket: async (request) => {
      assert.deepEqual(request.commitAuthorization, authorization); return { status: "accepted", resumed_from_turn: 13 };
    } } });
  assert.equal((await dispatch({ projectId: "P", ticketId: "T", commitAuthorization: authorization })).resumed_from_turn, 13);
  await assert.rejects(dispatch({ projectId: "P", ticketId: "T", commitAuthorization: authorization, fresh: true }), { code: "COMMIT_AUTHORIZATION_SCOPE" });
});

test("Coder rulebook and both provider prompts explicitly request ticket commit after focused checks", async () => {
  const rulebook = await readFile(new URL("../../../workflows/agents/coder/README.md", import.meta.url), "utf8");
  assert.match(rulebook, /For an approved ticket, commit the files you changed after focused checks pass/);
  assert.doesNotMatch(rulebook, /Do not commit unless explicitly asked/);
  for (const build of [buildCodexTicketPrompt, buildToolTicketPrompt]) {
    const prompt = build({ id: "T", title: "Repair", objective: "Repair", acceptance_criteria: ["Works"] }, "backend/example.js", ["backend/"], "simple");
    assert.match(prompt, /explicitly requests a commit of Coder-changed ticket files after implementation and passing focused checks/);
    assert.match(prompt, /does not override an existing approval denial/);
  }
});

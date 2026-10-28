/** Reproduces empty SL evidence blocking an AM consultation and verifies that
 * lookup, provider generation and live validation agree without accepting
 * fabricated source proofs or replaying completed Coder work. */
import test from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { createLookupSchemaTool } from "../../src/tools/lookup-schema-tool.js";
import { AGENT_DECISION_ACTIONS, agentDecisionEvidenceError } from "../../src/modules/governance/agent-decision-schema.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";
import { validateBlockerDisposition } from "../../src/modules/supervisor/blocker-recovery-contract.js";
import { blockerCorrectionPrompt, salvagePersistedDisposition } from "../../src/modules/supervisor/blocker-disposition-correction.js";
import { discoveryAssignment } from "../../src/modules/supervisor/blocker-discovery-checkpoint.js";
import { blockerResponseEvidence } from "../../src/modules/supervisor/blocker-validation.js";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";

const evidence = { path: "backend/src/handler.js", sha256: "a".repeat(64) };
const reconciliation = { kind: "dependency", prerequisite: "The frontend-owned browser scenario times out at 375px.",
  completed_checks: ["The backend focused tests passed; browser verification failed waiting for Saved."],
  next_check: "AM decides the repair route while preserving frontend ownership.",
  waiting_for: [{ owner: "architecture_manager", operation: "inspect", question: "Which owning ticket should repair the Saved-state failure?" }] };
const decision = { action: "reconciliation_required", summary: "Route the frontend dependency question to AM.",
  guidance: "Keep the Coder checkpoint and backend commit; obtain the frontend repair disposition.", evidence: [], reconciliation };

/** Retrieves every schema page through the actual agent tool, so cardinality
 * checks cover the contract seen by agents rather than a second test schema. */
async function lookup(role, action) {
  const tool = createLookupSchemaTool({ role }), input = { schema_id: `${role}.blocker_decision.v1`, action };
  const context = { task_id: "TASK", capabilities: ["lookup_schema"], agent_identity: { role } };
  let page = await tool.execute(input, context), content = "";
  if (!page.json_fragment) return page;
  for (;;) {
    content += page.json_fragment;
    if (page.complete) return JSON.parse(content);
    page = await tool.execute({ ...input, cursor: page.next_cursor }, context);
  }
}

test("lookup and native schemas use the live evidence rules for every SL and AM action", async () => {
  const ajv = new Ajv2020({ strict: false });
  for (const [role, actions] of Object.entries(AGENT_DECISION_ACTIONS)) {
    const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role }, payload: {} });
    for (const action of actions) {
      const document = await lookup(role, action);
      const branch = document.schema.properties.payload.properties.decision.anyOf[0];
      const native = output.schema.properties.payload.properties.decision.anyOf.find((entry) => entry.properties.action.enum[0] === action);
      const required = ["resolved", "sprint_required", "owner_required"].includes(action);
      assert.equal(branch.required.includes("evidence"), required);
      assert(document.rules.some((rule) => rule.includes("separate from envelope evidence")));
      const validators = [ajv.compile(branch.properties.evidence), ajv.compile(native.properties.evidence)];
      for (const value of [[], [evidence], Array(16).fill(evidence), Array(17).fill(evidence),
        [{ ...evidence, sha256: "sha256:" + evidence.sha256 }], [{ ...evidence, path: " " }], [{ ...evidence, extra: true }]]) {
        const valid = agentDecisionEvidenceError(value, { required }) === null;
        for (const validate of validators) assert.equal(validate(value), valid, `${role}/${action}: ${JSON.stringify(value).slice(0, 100)}`);
      }
      const validate = ajv.compile(document.schema);
      const response = structuredClone(document.example);
      response.payload.decision.evidence = [];
      assert.equal(validate(response), !required, `${role}/${action}: empty evidence`);
      delete response.payload.decision.evidence;
      assert.equal(validate(response), !required, `${role}/${action}: omitted evidence`);
    }
  }
});

test("live consultation allows absent evidence but still rejects malformed and stale supplied references", async () => {
  const f = await blockerRecoveryFixture();
  try {
    const options = { job: { stage: "sprint_leader", request: { task_id: "TASK", ticket: f.ticket } },
      plan: { content: {} }, projectRoot: f.base.workspace.projectRoot, fileService: f.base.fileService };
    for (const action of ["architecture_required", "reconciliation_required", "coder_requested"]) {
      const value = action === "coder_requested" ? { action, summary: "One implementation fact is missing.", guidance: "Inspect only the missing handler fact.", coder_request: {
        questions: ["Which handler assertion failed?"], constraints: ["Read-only response; preserve the checkpoint."] } }
        : { ...decision, action };
      for (const evidence of [undefined, []]) assert.equal((await validateBlockerDisposition({ ...value, evidence }, options)).action, action);
    }
    for (const evidence of [{}, Array(17).fill(f.evidence), [{ ...f.evidence, sha256: "short" }], [{ ...f.evidence, extra: true }]]) {
      await assert.rejects(validateBlockerDisposition({ ...decision, evidence }, options), { code: "BLOCKER_DISPOSITION_INVALID" });
    }
    await assert.rejects(validateBlockerDisposition({ ...decision, evidence: [evidence] }, options),
      (error) => error.validation_errors[0].reason === "evidence_stale");
    for (const evidence of [undefined, []]) await assert.rejects(validateBlockerDisposition({ ...f.resolution, evidence }, options),
      (error) => error.validation_errors[0].reason === "evidence_invalid");
  } finally { await f.close(); }
});

test("a retained empty-evidence consultation validates after the fix without another provider invocation", async () => {
  const f = await blockerRecoveryFixture();
  try {
    const job = { id: "JOB", stage: "sprint_leader", request: { task_id: "TASK", ticket: f.ticket },
      disposition_attempts: [{ stage: "sprint_leader", status: "rejected", response: blockerResponseEvidence(decision) }] };
    const ledger = { calls: 2 };
    const result = await salvagePersistedDisposition({ work: {}, job,
      update: async (_work, change) => { change(job, ledger); return job; },
      checkDisposition: (value) => validateBlockerDisposition(value, { job, plan: { content: {} },
        projectRoot: f.base.workspace.projectRoot, fileService: f.base.fileService }) });
    assert.deepEqual(result, decision);
    assert.equal(job.disposition_attempts[0].status, "received");
    assert.equal(ledger.calls, 1);
    assert.equal(f.calls.length, 0);
  } finally { await f.close(); }
});

test("correction reuses exact same-assignment source receipts without fabricating evidence or changing the job", () => {
  const job = { id: "JOB", stage: "sprint_leader", validation_feedback: [{ path: "/payload/decision/evidence", reason: "minItems" }],
    request: { payload: { execution_id: "EXEC" } } };
  const receipts = [{ tool: "read_lines", input: { path: evidence.path }, source_sha256: `sha256:${evidence.sha256}` },
    { tool: "read_file", input: { path: ".forge/runtime/blocker-context/TASK/copy.json" }, source_sha256: `sha256:${"b".repeat(64)}` },
    { tool: "read_file", input: { path: "backend/invalid.js" }, source_sha256: "short" }];
  job.discovery_checkpoints = { sprint_leader: { assignment_id: discoveryAssignment(job), receipts } };
  const before = structuredClone(job), prompt = blockerCorrectionPrompt(job);
  assert(prompt.includes(JSON.stringify(evidence)));
  assert.doesNotMatch(prompt, /copy.json|invalid.js/);
  assert.match(prompt, /evidence may be omitted or \[\]/);
  assert.match(prompt, /agent chooses|select only relevant citations/);
  assert.deepEqual(job, before);
  job.request.payload.execution_id = "REPLACED";
  assert(!blockerCorrectionPrompt(job).includes(JSON.stringify(evidence)));
});

test("empty-evidence SL dependency reaches AM once and returns to the original Coder checkpoint", async () => {
  const result = { findings: ["Repair belongs to the existing frontend owner."], implementation_steps: ["Resume after frontend handback."],
    verification_steps: ["Rerun only the affected browser scenario."], admission: { status: "within_existing_permissions", rationale: "No scope expansion." } };
  const f = await blockerRecoveryFixture({ investigate: async (job, resolution) => job.stage === "sprint_leader" && !job.architecture_response
    ? decision : { ...resolution, technical_result: result } });
  try {
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    const checkpoint = await f.base.checkpoints.load("TASK");
    await f.recovery.tick();
    assert.equal((await f.ledger()).jobs[0].stage, "architecture_manager");
    await f.recreate().tick(); await f.recovery.tick(); await f.recovery.tick();
    assert.deepEqual(f.calls, ["sprint_leader", "architecture_manager", "sprint_leader"]);
    assert.equal((await f.ledger()).jobs[0].status, "resumed");
    assert.equal(f.base.invocations, 2);
    assert.equal((await f.base.checkpoints.load("TASK")).blocker_recovery.ticket_progress.last_completed_turn, checkpoint.last_completed_turn);
  } finally { await f.close(); }
});

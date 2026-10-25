/** Verifies shared recovery messages preserve real checkpoint and authority
 * boundaries while SL asks a focused question and AM returns its answer to SL. */
import test from "node:test";
import assert from "node:assert/strict";
import { blockerRecoveryFixture } from "../fixtures/blocker-recovery-fixture.js";
import { createBlockerRecoveryAgent } from "../../src/modules/supervisor/blocker-recovery-agent.js";
import { blockerExchangeRequest, blockerExchangeResponse } from "../../src/modules/supervisor/blocker-agent-exchange.js";
import { blockerExchangePrompt } from "../../src/modules/supervisor/blocker-exchange-prompt.js";
import { createAgentExchangeStorage } from "../../src/modules/governance/agent-exchange-storage.js";
import { createClaudeSdkGateway } from "../../src/modules/agent/claude-sdk-gateway.js";

/** Supplies the four model-authored fields with the existing business contract;
 * native validation still controls source hashes and permission prerequisites. */
function response(decision, consultation) {
  const outcome = consultation ? "needs_higher_authority" : "answered";
  return { kind: "consultation_response", subject: decision.summary, evidence: [], payload: { outcome, answer: decision.summary,
    rationale: "Use the retained approved authority and inspected evidence.", authority_refs: [], next_steps: [decision.guidance], decision,
    ...(consultation ? { consultation } : {}) } };
}

test("SL's explicit question survives normalization and AM never receives a full-ticket audit assignment", () => {
  const consultation = { question: "Which permitted contract resolves the changed assertion?", decision_needed: "Return the permitted continuation.", known_decision_refs: ["AM-OLD"], impact: "One verification prerequisite remains." };
  const job = { id: "J", stage: "sprint_leader", reason_code: "SECURITY_RISK", history: [], request: { project_id: "P", task_id: "T", payload: { execution_id: "E" }, ticket: {} } };
  const resolver = { resolveProfile: (role) => ({ agent_id: `agent-${role}`, role }) };
  const request = blockerExchangeRequest(job, { agent_id: "SL", role: "sprint_leader" }, resolver);
  const decoded = blockerExchangeResponse(response({ action: "architecture_required", summary: "One contract question remains.", guidance: "Ask AM the unresolved question." }, consultation), request);
  const amRequest = blockerExchangeRequest({ ...job, stage: "architecture_manager", resolution: decoded.value }, { agent_id: "AM", role: "architecture_manager" }, resolver);
  assert.equal(amRequest.payload.question, consultation.question);
  assert.equal(amRequest.payload.decision_needed, consultation.decision_needed);
  assert.equal(amRequest.recipient.role, "architecture_manager");
  assert.equal(amRequest.sender.role, "sprint_leader");
  assert.doesNotMatch(JSON.stringify(amRequest), /transport acceptance|EVERY original criterion|audit/);
});

test("AM prompt makes approved-plan authority final and reserves Owner escalation for scope or structure boundaries", () => {
  const prompt = blockerExchangePrompt({
    request: { kind: "consultation_request", recipient: { role: "architecture_manager" }, payload: { question: "Resolve the approved tool behavior." }, subject: "Consult AM" },
    job: { authority_context: { architecture: { basis: { plan_id: "ARCH", revision: 1, sha256: "a".repeat(64) } }, passages: [] },
      contract_context: null, architecture_response: null, reason_code: "SECURITY_RISK", ticket_progress: {}, message: "Review denial" },
    context: { summary: "Focused consultation." }, tools: { definitions: [] }
  });
  assert.match(prompt, /final decision-maker for technical and policy choices covered by the approved Architecture\/Sprint plan/);
  assert.match(prompt, /tool-review denial is not automatically an Owner policy decision/);
  assert.match(prompt, /outside approved scope\/owner authority or presents evidenced risk to project structure/);
  assert.match(prompt, /automated tool-review denial does not itself override an approved plan decision/);
  assert.doesNotMatch(prompt, /A denied tool remains denied/);
});

test("real recovery routes structured SL -> AM -> SL, saves exchanges and resumes Coder once", async () => {
  const consultation = { question: "Can Coder reuse the approved adapter?", decision_needed: "Choose the existing implementation path.",
    known_decision_refs: ["AM-EXISTING"], impact: "One adapter implementation is blocked." };
  const f = await blockerRecoveryFixture({ consultation });
  const calls = [];
  let sdkFailure;
  try {
    const resolver = { resolveProfile: (role) => ({ agent_id: role, role }),
      resolveAvailable: (role) => ({ agent_id: role, role, provider: "anthropic", enabled: true, status: "ready" }) };
    const worker = createBlockerRecoveryAgent({ agentResolver: resolver, clock: () => 1000,
      agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} },
      resolveTicketWorkspace: async () => f.base.workspace,
      gateways: { claudeSdkGateway: { execute: async (input) => {
        const { agent, prompt, options } = input;
        calls.push(agent.role);
        assert.equal(options.outputFormat.type, "json_schema");
        assert.deepEqual(options.outputFormat.schema.properties.kind.enum, ["consultation_response"]);
        assert(options.tools.every((tool) => tool === "WebSearch"));
        assert.match(prompt, /^AGENT EXCHANGE v1/);
        assert.doesNotMatch(prompt, /transport acceptance|CLI grammar/);
        let value;
        if (calls.length === 1) {
          assert.match(prompt.split("\n")[0], /Can Coder reuse the approved adapter/);
          value = response({ ...f.resolution, action: "architecture_required" }, {
          question: "Can the existing handler contract be used?", decision_needed: "Confirm its applicability.", known_decision_refs: [], impact: "Coder awaits this answer." });
        }
        if (agent.role === "architecture_manager") assert.match(prompt.split("\n")[0], /Can the existing handler contract be used/);
        value ??= response(f.resolution);
        const gateway = createClaudeSdkGateway({ configuration: { getById: () => ({ ...agent, credential_ref: "fixture", gateway_url: "https://gateway.test" }) },
          credentialResolver: () => "fixture-key", terminalOutput: { write() {} },
          queryFn: ({ options: native }) => (async function* () {
            assert.deepEqual(native.outputFormat, options.outputFormat);
            yield { type: "assistant", message: { content: [{ type: "text", text: "I'm retrieving evidence. <tool_call>read_file</tool_call>" }] } };
            yield { type: "result", subtype: "success", is_error: false, result: "Display text only.", structured_output: value };
          })() });
        try { return await gateway.execute(input); }
        catch (error) { sdkFailure = error; throw error; }
      } } }
    });
    f.recreate({ investigate: worker });
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 4; turn++) await f.recovery.tick();
    assert.ifError(sdkFailure);
    const job = (await f.ledger()).jobs[0];
    assert.deepEqual(calls, ["sprint_leader", "architecture_manager", "sprint_leader"], JSON.stringify({ status: job.status, reason: job.reason_code, message: job.message, history: job.history.slice(-2) }));
    assert.equal(job.status, "resumed");
    assert.equal(f.base.integrations, 1);
    const storage = createAgentExchangeStorage({ fileService: f.base.fileService });
    const context = { project_id: job.request.project_id, ticket_id: job.request.task_id, execution_id: job.request.payload.execution_id };
    const saved = await storage.read(context, job.communication.response_id);
    assert.equal(saved.in_reply_to, job.communication.request_id);
  } finally { await f.close(); }
});

test("AM validator correction retains the request, disables discovery and persists the correction", async () => {
  const f = await blockerRecoveryFixture();
  try {
    const events = [];
    const profile = { agent_id: "AM", role: "architecture_manager", provider: "codex", enabled: true, status: "ready" };
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
      agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} }, resolveTicketWorkspace: async () => f.base.workspace,
      gateways: { codexSdkGateway: { execute: async ({ prompt, options }) => {
        assert.deepEqual(options.forgeTools.definitions, []);
        assert.equal(options.webSearchMode, "disabled");
        assert.match(prompt, /RESPONSE CORRECTION ONLY/);
        assert.match(prompt, /The existing contract applies/);
        return { text: JSON.stringify(response(f.resolution)) };
      } } }
    });
    const job = { id: "J", stage: "architecture_manager", reason_code: "SCOPE_CONFLICT", request: { project_id: "P", task_id: "TASK", payload: { execution_id: "E" }, ticket: f.ticket },
      resolution: { action: "architecture_required", summary: "Confirm the handler contract.", guidance: "Answer this point only." }, history: [],
      validation_feedback: [{ path: "/", reason: "json_invalid", message: "Return JSON only." }],
      disposition_attempts: [{ response: { text: "The existing contract applies.", sha256: "prior-response" } }] };
    const before = structuredClone(job);
    await worker(job, { deadline: Date.now() + 5000, onCommunication: async (event) => events.push(event) });
    assert.deepEqual(job, before);
    assert.ok(events.some((event) => event.correction_id));
    assert.ok(events.some((event) => event.response_id));
  } finally { await f.close(); }
});

test("AM authority corrections use Node-supplied identity and passage references without reopening discovery", async () => {
  const f = await blockerRecoveryFixture();
  const basis = { plan_id: "ARCH-P", revision: 3, sha256: "a".repeat(64) };
  const authorityContext = { architecture: { basis }, passages: [{ scope: "architecture", passage_id: "PASSAGE-1", text: "Approved architectural direction." }] };
  try {
    const profile = { agent_id: "AM", role: "architecture_manager", provider: "codex", enabled: true, status: "ready" };
    const worker = createBlockerRecoveryAgent({ agentResolver: { resolveAvailable: () => profile },
      agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} }, resolveTicketWorkspace: async () => f.base.workspace,
      gateways: { codexSdkGateway: { execute: async ({ prompt, options }) => {
        assert.deepEqual(options.forgeTools.definitions, []);
        assert.match(prompt, /NODE-VERIFIED ARCHITECTURE IDENTITY:.*ARCH-P/);
        assert.match(prompt, /NODE-ISSUED AUTHORITY PASSAGES:.*PASSAGE-1/);
        assert.match(prompt, /RESPONSE CORRECTION ONLY/);
        assert.match(prompt, /action=sprint_required.*authority_scope=architecture/s);
        assert.match(prompt, /For action=reconciliation_required.*omit technical_result/);
        return { text: JSON.stringify(response(f.resolution)) };
      } } }
    });
    const job = { id: "J", stage: "architecture_manager", reason_code: "SCOPE_CONFLICT", request: { project_id: "P", task_id: "TASK", payload: { execution_id: "E" }, ticket: f.ticket },
      resolution: { action: "architecture_required", summary: "Confirm the handler contract.", guidance: "Answer this point only." }, history: [], authority_context: authorityContext,
      validation_feedback: [
        { path: "/architecture_basis/plan_id", reason: "identity_mismatch", message: "Copy the Node-verified value.", expected: basis.plan_id },
        { path: "/technical_result", reason: "technical_result_incomplete", message: "Remove incomplete results from unresolved dispositions." }
      ],
      disposition_attempts: [{ response: { text: "The existing contract applies.", sha256: "prior-response" } }] };
    await worker(job, { deadline: Date.now() + 5000 });
  } finally { await f.close(); }
});

test("shared responses carry source evidence for an out-of-plan Owner consultation", async () => {
  const job = { id: "J", stage: "architecture_manager", reason_code: "ACCESS_REQUIRED", request: { project_id: "P", task_id: "T", payload: { execution_id: "E" }, ticket: {} }, history: [] };
  const request = blockerExchangeRequest(job, { agent_id: "AM", role: "architecture_manager" });
  const value = blockerExchangeResponse({ action: "owner_required", summary: "This policy change is outside the approved scope.", guidance: "Owner must decide whether to add it.",
    boundary_assessment: { rationale: "Only a tool permission is missing.", changes_structure: false, changes_owner_scope: false,
      changes_security_policy: true, changes_data_semantics: false, overrides_guardrails: false, changes_ticket_contract: false },
    evidence: [{ path: "backend/src/application/tool-policy.js", sha256: "a".repeat(64) }] }, request);
  assert.equal(value.response.payload.consultation.owner_boundary_risk.boundary, "approved_scope");
  assert.deepEqual(value.response.payload.consultation.owner_boundary_risk.evidence_refs, ["backend/src/application/tool-policy.js"]);
});

/** Exercises the production exchange branch for both SDKs: a wrong AM-only
 * action gets a format correction, then SL resumes Coder without another AM call
 * or rediscovery of the settled implementation question. */
for (const provider of ["codex", "claude"]) test(`${provider} SL corrects an AM-only action and resumes Coder without a Node admission wait`, async () => {
  const f = await blockerRecoveryFixture();
  const calls = [];
  try {
    const profile = { agent_id: "SL", role: "sprint_leader", provider, enabled: true, status: "ready" };
    const worker = createBlockerRecoveryAgent({ clock: () => 1000, agentResolver: { resolveAvailable: () => profile },
      agentOccupancy: { claim: async () => ({ claim_id: "C" }), release: async () => {} },
      resolveTicketWorkspace: async () => f.base.workspace,
      gateways: { [provider === "codex" ? "codexSdkGateway" : "claudeSdkGateway"]: { execute: async ({ prompt, options, agent }) => {
        calls.push(agent.role);
        assert.match(prompt, /^AGENT EXCHANGE v1/);
        assert.match(prompt, /no separate Node admission step/i);
        assert.match(prompt, /payload\.decision must use \{action: resolved\|architecture_required\|reconciliation_required\|coder_requested/);
        assert.match(prompt, /SL cannot return sprint_required/);
        assert.match(prompt, /After a settled AM answer use resolved to hand work to Coder/);
        assert.doesNotMatch(prompt, /Return ONLY JSON: \{action/);
        if (calls.length === 2) {
          assert.match(prompt, /RESPONSE CORRECTION ONLY/);
          assert.match(prompt, /role_action_mismatch/);
          if (provider === "codex") assert.deepEqual(options.forgeTools.definitions, []);
          else assert.deepEqual(options.allowedTools, []);
        }
        return { text: JSON.stringify(response({ ...f.resolution, authority_scope: "sprint",
          action: calls.length === 1 ? "sprint_required" : "resolved" })) };
      } } }
    });
    f.recreate({ investigate: worker });
    await assert.rejects(f.base.run(), { code: "CODER_BLOCKED" });
    for (let turn = 0; turn < 3; turn++) await f.recovery.tick();
    assert.deepEqual(calls, ["sprint_leader", "sprint_leader"]);
    const job = (await f.ledger()).jobs[0];
    assert.equal(job.status, "resumed");
    assert.equal(job.disposition_attempts[0].validation_errors[0].path, "/action");
    assert.equal(job.execution_admission, undefined);
    assert.equal(f.base.integrations, 1);
  } finally { await f.close(); }
});

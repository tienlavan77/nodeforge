/** Exercises shared routing, conditional payloads and immutable identity binding
 * so malformed agent responses cannot launch work or consult the wrong authority. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentExchange, bindAgentExchangeResponse, assertAgentExchange } from "../../src/modules/governance/agent-exchange.js";
import { createAgentExchangeStorage } from "../../src/modules/governance/agent-exchange-storage.js";
import { createFileService } from "../../src/infrastructure/filesystem/file-service.js";
import { agentExchangePrompt } from "../../src/modules/governance/agent-exchange-prompt.js";

const context = { project_id: "P", ticket_id: "T", execution_id: "E" };
const party = (role) => ({ agent_id: role, role });
const question = { question: "Which existing contract applies?", decision_needed: "Choose the permitted continuation.", known_decision_refs: [], impact: "Coder cannot select a contract." };
const reply = { kind: "consultation_response", subject: "The existing contract applies.", evidence: [], payload: {
  outcome: "answered", answer: "Use the retained contract.", rationale: "Its approved scope covers the question.", authority_refs: [], next_steps: ["Continue the missing repair."] } };

/** Builds an authenticated consultation fixture without borrowing production
 * identities, runtime records or an agent's own routing claims. */
function request(from = "sprint_leader", to = "architecture_manager", payload = question) {
  return createAgentExchange({ context, sender: party(from), recipient: party(to), kind: "consultation_request", subject: "Contract consultation", payload });
}

test("consultation follows Coder -> SL -> AM and responses return to their request", () => {
  for (const [from, to] of [["coder", "sprint_leader"], ["sprint_leader", "architecture_manager"]]) {
    const input = request(from, to), result = bindAgentExchangeResponse(reply, input);
    assert.equal(result.in_reply_to, input.message_id);
    assert.deepEqual(result.recipient, input.sender);
    assert.deepEqual(result.context, context);
  }
  for (const [from, to] of [["coder", "architecture_manager"], ["reviewer", "architecture_manager"], ["sprint_leader", "project_owner"], ["architecture_manager", "coder"]]) {
    assert.throws(() => request(from, to), { code: "AGENT_EXCHANGE_INVALID" });
  }
});

test("AM consults Owner only with evidence of out-of-plan scope or project structure risk", () => {
  assert.throws(() => request("architecture_manager", "project_owner"), /approved-scope or project-structure boundary risk/);
  const risk = { structure: "Project routing ownership", proposed_change: "Introduce a new routing authority.", rationale: "Current structure cannot own this boundary.", evidence_refs: ["approved-plan:architecture"] };
  assert.equal(request("architecture_manager", "project_owner", { ...question, structure_change_risk: risk }).recipient.role, "project_owner");
  const scopeRisk = { boundary: "approved_scope", proposed_change: "Add a policy beyond the approved Sprint.", rationale: "The plan does not delegate this change.", evidence_refs: ["approved-plan:sprint"] };
  assert.equal(request("architecture_manager", "project_owner", { ...question, owner_boundary_risk: scopeRisk }).recipient.role, "project_owner");
  assert.throws(() => bindAgentExchangeResponse({ ...reply, payload: { ...reply.payload, outcome: "needs_higher_authority", consultation: question } }, request()), /approved-scope or project-structure boundary/);
});

test("responses cannot replace execution, request, participants or Node-owned metadata", () => {
  const input = request(), valid = bindAgentExchangeResponse(reply, input);
  for (const changed of [{ ...valid, context: { ...context, execution_id: "OTHER" } }, { ...valid, in_reply_to: "other" },
    { ...valid, sender: party("reviewer") }, { ...reply, recipient: party("coder") }]) {
    assert.throws(() => bindAgentExchangeResponse(changed, input), { code: "AGENT_EXCHANGE_INVALID" });
  }
  assert.throws(() => bindAgentExchangeResponse({ ...reply, kind: "work_result" }, input), { code: "AGENT_EXCHANGE_INVALID" });
  assert.throws(() => bindAgentExchangeResponse({ ...reply, evidence: [
    { type: "verification_receipt", ref: "CHECK-1", purpose: "Prove baseline behavior." }] }, input),
  (error) => error.validation_errors[0].path === "/evidence/0/type"
    && error.message.includes('["source","verification","finding","report","decision","denial"]'));
  assert.throws(() => assertAgentExchange({ ...valid, subject: "Tampered decision" }), /immutable identity/);
});

test("missing evidence requires its concrete purpose and unknown payload fields are rejected", () => {
  const input = request();
  const payload = { ...reply.payload, outcome: "needs_evidence" };
  assert.throws(() => bindAgentExchangeResponse({ ...reply, payload }, input), /missing_evidence/);
  assert.throws(() => bindAgentExchangeResponse({ ...reply, payload: { ...payload, missing_evidence: [{ needed: "Logs" }] } }, input), /needed_for/);
  assert.throws(() => bindAgentExchangeResponse({ ...reply, payload: { ...reply.payload, dispatch_coder: true } }, input), /additional properties/);
  assert.throws(() => bindAgentExchangeResponse({ ...reply, payload: { ...payload, missing_evidence: [{ needed: "Logs" }] } }, input),
    (error) => error.validation_errors[0].path === "/payload/missing_evidence/0/needed_for");
});

test("storage survives restart, deduplicates retries and rejects cross-execution reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-exchange-"));
  try {
    const files = createFileService({ projectRoot: root, role: "system_engineer" });
    const storage = createAgentExchangeStorage({ fileService: files }), input = request();
    const result = bindAgentExchangeResponse(reply, input);
    await assert.rejects(storage.save(result), { code: "ENOENT" });
    const first = await storage.save(input);
    assert.deepEqual(await storage.save(input), first);
    await storage.save(result);
    const restarted = createAgentExchangeStorage({ fileService: files });
    assert.deepEqual(await restarted.read(context, result.message_id), result);
    await assert.rejects(restarted.read({ ...context, execution_id: "OTHER" }, result.message_id), /context changed/);
    await files.atomicWrite({ path: first.ref, content: JSON.stringify({ ...input, subject: "Rewritten" }), replace: true });
    await assert.rejects(restarted.read(context, input.message_id), /immutable identity/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("prompt presents the exact question first and only the selected payload definitions", () => {
  const input = request(), prompt = agentExchangePrompt(input, "consultation_response");
  assert.ok(prompt.indexOf(input.payload.question) < prompt.indexOf("Payload JSON Schema"));
  assert.doesNotMatch(prompt, /"review_result":|"work_result":/);
  assert.match(prompt, /No preamble/);
  assert.match(prompt, /Coder and Reviewer never initiate Architecture consultations directly/);
  assert.match(prompt, /"source","verification","finding","report","decision","denial"/);
  assert.match(prompt, /do not invent labels such as verification_receipt or retained_denial/i);
});

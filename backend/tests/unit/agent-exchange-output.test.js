/** Verifies native structured generation uses the existing communication
 * contract while optional nullable SDK slots cannot become authority, silently
 * erase invalid fields, or change new-file and report null semantics. */
import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createAgentExchangeOutput } from "../../src/modules/governance/agent-exchange-output.js";
import { assertAgentExchangePayload } from "../../src/modules/governance/agent-exchange.js";

/** Fills strict-schema optional slots as a native SDK would, without inventing
 * missing required facts or changing any supplied response values. */
function slots(value, schema) {
  if (schema.anyOf) {
    if (value === undefined && schema.anyOf.some((entry) => entry.type === "null")) return null;
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    return slots(value, schema.anyOf.find((entry) => (entry.type === type || entry.type?.includes?.(type))
      && (!entry.properties?.action?.enum || entry.properties.action.enum.includes(value?.action))) ?? schema.anyOf[0]);
  }
  if (schema.type === "object") return Object.fromEntries(Object.entries(schema.properties).map(([key, child]) => [key, slots(value?.[key], child)]));
  if (schema.type === "array") return (value ?? []).map((entry) => slots(entry, schema.items));
  return value;
}

/** Supplies a legitimate narrow AM answer with the technical handoff that
 * live recovery requires independently of native syntax constraints. */
function answer() {
  return { kind: "consultation_response", subject: "Retained question answered.", evidence: [], payload: {
    outcome: "answered", answer: "Continue the approved scope.", rationale: "Existing approved authority applies.", authority_refs: [], next_steps: ["Return to SL."],
    decision: { action: "resolved", summary: "The retained question is answered.", guidance: "Continue within existing scope.", authority_scope: "architecture",
      technical_result: { findings: ["Existing evidence resolves the question."], implementation_steps: ["Continue the existing handler."],
        verification_steps: ["Run the handler test."], admission: { status: "within_existing_permissions", rationale: "No new permission is required." } } } } };
}

test("native schemas are self-contained, strict, and normalize only unused optional slots", () => {
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } });
  const response = answer(), native = slots(response, output.schema);
  const validate = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validate(native), true, JSON.stringify(validate.errors));
  assert.equal(native.payload.consultation, null);
  assert.equal(native.payload.decision.reconciliation, null);
  assert.deepEqual(output.normalize(native), response);
  assertAgentExchangePayload(response.kind, output.normalize(native).payload);
  assert.deepEqual(Object.keys(output.schema.properties).sort(), ["evidence", "kind", "payload", "subject"]);
  assert.doesNotMatch(JSON.stringify(output.schema), /"\$ref"|"if"|"then"|"oneOf"/);
  // Verifies every nested object meets the native strict-output contract.
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") { assert.equal(node.additionalProperties, false); assert.deepEqual(node.required, Object.keys(node.properties)); }
    for (const child of Object.values(node)) if (Array.isArray(child)) child.forEach(visit); else visit(child);
  };
  visit(output.schema);
});

test("the generated schema rejects invented reconciliation enums and transport identity fields", () => {
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } });
  const validate = new Ajv2020({ strict: false }).compile(output.schema);
  const value = answer();
  value.payload.decision = { action: "reconciliation_required", summary: "Need one source fact.", reconciliation: {
    kind: "verification", prerequisite: "One source fact.", completed_checks: ["Read the report."], next_check: "Inspect exact evidence.", waiting_for: [] } };
  assert.equal(validate(slots(value, output.schema)), false);
  value.payload.decision.reconciliation.kind = "source_revision";
  assert.equal(validate(slots(value, output.schema)), true, JSON.stringify(validate.errors));
  const native = slots(value, output.schema);
  native.sender = { role: "project_owner" };
  assert.equal(validate(native), false);
  assert.deepEqual(output.normalize(native).sender, native.sender);
});

test("independent Reviewer schema pins the subject and forbids verdicts or finding mutations", () => {
  const subject = { commit_sha: "a".repeat(40), artifact_id: "ARTIFACT-ONE" };
  const output = createAgentExchangeOutput({ kind: "review_request", recipient: { role: "reviewer" }, payload: { purpose: "blocker_evidence", subject } });
  const value = { kind: "review_result", subject: "Exact evidence inspected.", evidence: [], payload: { purpose: "blocker_evidence", subject,
    outcome: "completed", summary: "Source inspection completed.", observations: ["Source matches the receipt."], missing_evidence: [], findings: [], finding_updates: [] } };
  const validate = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validate(slots(value, output.schema)), true, JSON.stringify(validate.errors));
  assertAgentExchangePayload(value.kind, output.normalize(slots(value, output.schema)).payload);
  for (const patch of [{ subject: { ...subject, artifact_id: "ARTIFACT-OTHER" } }, { verdict: "approved" }, { findings: [{ id: "REV-1" }] }]) {
    const changed = slots(value, output.schema); Object.assign(changed.payload, patch);
    assert.equal(validate(changed), false);
  }
});

test("Coder new-file checksums and required nullable report refs survive normalization", () => {
  const output = createAgentExchangeOutput({ kind: "work_request", recipient: { role: "coder" } });
  const value = { kind: "work_result", subject: "Specific candidate prepared.", evidence: [], payload: { outcome: "completed", summary: "Candidate prepared.",
    change_refs: [], verification_refs: [], report_ref: null, remaining_work: [], candidate: { changes: [{ path: "backend/src/new.js", sha256: null,
      patch: "--- /dev/null\n+++ b/backend/src/new.js\n@@ -0,0 +1 @@\n+export const value = 1;", rationale: "The approved handler needs this source." }], verification_steps: ["Run its focused test."] } } };
  const native = slots(value, output.schema), validate = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validate(native), true, JSON.stringify(validate.errors));
  assert.deepEqual(output.normalize(native), value);
  assertAgentExchangePayload(value.kind, output.normalize(native).payload);
});

test("required nulls and fabricated fields remain rejected by the original contract", () => {
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } });
  const value = slots(answer(), output.schema);
  value.payload.answer = null;
  value.payload.invented_approval = null;
  const normalized = output.normalize(value);
  assert.equal(normalized.payload.answer, null);
  assert.equal(normalized.payload.invented_approval, null);
  assert.throws(() => assertAgentExchangePayload("consultation_response", normalized.payload));
});

test("native resolved decisions require the complete technical handoff before reaching Forge", () => {
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "architecture_manager" } });
  const validate = new Ajv2020({ strict: false }).compile(output.schema);
  const value = slots(answer(), output.schema);
  value.payload.decision.technical_result = null;
  assert.equal(validate(value), false);
  value.payload.decision.action = "reconciliation_required";
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
});

test("SL can retain typed criterion attribution and meaningful reference identities", () => {
  const output = createAgentExchangeOutput({ kind: "consultation_request", recipient: { role: "sprint_leader" } });
  const value = answer();
  value.payload.authority_refs = ["PASSAGE-SPRINT-1"];
  value.payload.decision.authority_scope = "sprint";
  value.payload.decision.criterion_updates = [{ criterion_id: "AC-1", files: [{ path: "backend/src/handler.js", sha256: "a".repeat(64) }], remaining_work: "" }];
  const native = slots(value, output.schema), validate = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validate(native), true, JSON.stringify(validate.errors));
  assert.deepEqual(output.normalize(native), value);
  assertAgentExchangePayload(value.kind, value.payload);
  native.payload.authority_refs = [{}];
  assert.equal(validate(native), false);
  native.payload.authority_refs = value.payload.authority_refs;
  native.payload.decision.criterion_updates[0].files[0].sha256 = "invented";
  assert.equal(validate(native), false);
});

test("native Reviewer output preserves a typed verification request and normalizes unused nullable slots", () => {
  const output = createAgentExchangeOutput({ kind: "review_request", recipient: { role: "reviewer" }, payload: {} });
  const request = { finding_ids: ["REV-1"], criterion_ids: ["AC-1"], test_paths: ["backend/tests/unit/security.test.js"], scope: "ticket",
    reason: "Commit-bound security coverage is missing.", artifact_id: "ARTIFACT-1", commit_sha: "a".repeat(40), source_revision: "source-1" };
  const value = { kind: "review_result", subject: "Run the missing focused check.", evidence: [], payload: {
    verdict: "verification_required", summary: "Node must supply the exact security receipt.", findings: [], finding_updates: [], verification_requests: [request] } };
  const native = slots(value, output.schema), validate = new Ajv2020({ strict: false }).compile(output.schema);
  assert.equal(validate(native), true, JSON.stringify(validate.errors));
  assert.deepEqual(output.normalize(native), value);
  assertAgentExchangePayload(value.kind, output.normalize(native).payload);
  native.payload.verification_requests[0].command = "node --test";
  assert.equal(validate(native), false);
});

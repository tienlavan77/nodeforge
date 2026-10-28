/** Keeps lookup, native SDK generation and validation on the same role-specific
 * decision contract so a formatting correction cannot become a new investigation. */
import { createRequire } from "node:module";
import Ajv2020 from "ajv/dist/2020.js";
const require = createRequire(import.meta.url);
const source = require("../../../../schemas/governance/agent-exchange-decision.schema.json");
const evidenceActions = source.allOf[0].if.properties.action.enum;
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addSchema(source);
const evidenceValidators = new Map([false, true].map((required) => [required,
  ajv.compile({ $ref: `${source.$id}#/$defs/${required ? "required_source_evidence" : "source_evidence"}` })]));

export const AGENT_DECISION_ACTIONS = Object.freeze({
  sprint_leader: ["resolved", "architecture_required", "reconciliation_required", "coder_requested", "dependency_requested"],
  architecture_manager: ["resolved", "owner_required", "governance_required", "reconciliation_required", "sprint_required"]
});
export const AGENT_DECISION_OUTCOMES = Object.freeze({ resolved: "answered", sprint_required: "answered",
  reconciliation_required: "needs_evidence", coder_requested: "needs_evidence", dependency_requested: "needs_evidence", architecture_required: "needs_higher_authority",
  owner_required: "needs_higher_authority", governance_required: "needs_higher_authority" });

/** Narrows only model-authored fields; live authority and source evidence are
 * still checked by their owning services after the response is decoded. */
export function agentDecisionSchema(role) {
  const schema = structuredClone(source);
  schema.properties.action.enum = [...(AGENT_DECISION_ACTIONS[role] ?? [])];
  const omitted = role === "architecture_manager" ? ["coder_request", "dependency_request", "candidate_review", "criterion_updates"]
    : ["architecture_basis", "boundary_assessment", "escalation", "proposal", "contract_draft"];
  for (const key of omitted) delete schema.properties[key];
  schema.allOf = [...schema.allOf,
    { if: { required: ["contract_draft"] }, then: { properties: { action: { const: "governance_required" } } } },
    { if: { required: ["reconciliation"], properties: { reconciliation: { required: ["owner_request"] } } },
      then: { properties: { action: { const: "reconciliation_required" }, reconciliation: { required: ["waiting_for"], properties: { waiting_for: { minItems: 1 } } } } } }
  ];
  return schema;
}

/** Validates source-reference shape from the same deployed contract used by
 * lookup and native SDK output. Files, hashes and authority remain live checks;
 * asking for missing evidence does not itself require invented source proof. */
export function agentDecisionEvidenceError(value, { required = true } = {}) {
  const validate = evidenceValidators.get(required);
  if (validate(value)) return null;
  const error = validate.errors[0];
  const field = error.params.missingProperty;
  const path = `/evidence${error.instancePath}${field ? `/${field}` : ""}`;
  const reason = path.endsWith("/sha256") ? "checksum_invalid" : path.endsWith("/path") ? "path_required"
    : error.keyword === "additionalProperties" ? "additional_property" : "evidence_invalid";
  return { path, reason, message: `Source evidence ${error.message}; see the active blocker_decision schema.`,
    expected: { task: "blocker_decision", required, minItems: required ? source.$defs.required_source_evidence.minItems : 0,
      maxItems: source.$defs.source_evidence.maxItems } };
}

/** Encodes action-dependent fields as explicit alternatives supported by strict
 * SDK schemas, rather than dropping their conditional rules during projection. */
export function agentDecisionBranches(decision) {
  return decision.properties.action.enum.map((action) => {
    const branch = structuredClone(decision);
    branch.properties.action = { enum: [action] };
    for (const [field, allowed] of Object.entries({ contract_draft: ["governance_required"],
      reconciliation: ["reconciliation_required"], coder_request: ["coder_requested"], dependency_request: ["dependency_requested"],
      technical_result: ["resolved"], escalation: ["owner_required"], proposal: ["owner_required"] })) {
      if (!allowed.includes(action)) delete branch.properties[field];
    }
    const required = { resolved: ["guidance", "evidence", "technical_result"], reconciliation_required: ["guidance", "reconciliation"],
      coder_requested: ["coder_request"], dependency_requested: ["dependency_request", "guidance", "authority_scope", "authority_reference"], governance_required: ["contract_draft"], owner_required: ["escalation", "proposal"] }[action] ?? [];
    branch.required = [...new Set([...branch.required, ...required])];
    if (action === "dependency_requested") branch.properties.authority_scope = { enum: ["sprint"] };
    if (evidenceActions.includes(action)) {
      branch.required = [...new Set([...branch.required, "evidence"])];
      branch.properties.evidence = { ...branch.properties.evidence, minItems: source.$defs.required_source_evidence.minItems };
    }
    return branch;
  });
}

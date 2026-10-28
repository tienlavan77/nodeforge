/** Resolves allowlisted response contracts into self-contained lookup documents.
 * All references come from the deployed contract catalog, never from agent paths. */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { agentExchangeResponseSchema } from "./agent-exchange-output.js";
import { agentDecisionBranches, AGENT_DECISION_OUTCOMES } from "./agent-decision-schema.js";
import { ARCHITECTURE_PLAN_JSON_SCHEMA } from "./architecture-plan-json.js";

const root = new URL("../../../../schemas/", import.meta.url);
const cache = new Map();

/** Loads immutable deployed schema documents once; response hashes describe the
 * exact schema served by this process and change after a deployment. */
function document(url) {
  if (!cache.has(url.href)) cache.set(url.href, JSON.parse(readFileSync(url, "utf8")));
  return cache.get(url.href);
}

/** Bundles local references losslessly, preserving conditional rules that the
 * provider's restricted native schema subset may not itself support. */
function bundle(value, url) {
  if (Array.isArray(value)) return value.map((item) => bundle(item, url));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const [file, pointer = ""] = value.$ref.split("#");
    const target = file ? new URL(file, url) : url;
    if (!target.href.startsWith(root.href)) throw new Error("Schema reference escapes deployed contracts.");
    const node = pointer.split("/").filter(Boolean).reduce((item, key) => item[key.replaceAll("~1", "/").replaceAll("~0", "~")], document(target));
    const siblings = { ...value }; delete siblings.$ref;
    return { ...bundle(node, target), ...bundle(siblings, url) };
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["$id", "$schema", "$defs", "$comment"].includes(key))
    .map(([key, child]) => [key, bundle(child, url)]));
}

/** Generates a shape example from the actual schema. Identity, hashes and
 * evidence remain placeholders that must be replaced by Node-issued facts. */
function example(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.anyOf || schema.oneOf) return example((schema.anyOf ?? schema.oneOf)[0]);
  if (schema.type === "object") return Object.fromEntries((schema.required ?? []).map((key) => [key, example(schema.properties[key])]));
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => example(schema.items));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return false;
  if (schema.type === "null" || Array.isArray(schema.type) && schema.type.includes("null")) return null;
  if (schema.pattern?.includes("a-f0-9")) return "a".repeat(schema.pattern.includes("40") ? 40 : 64);
  if (schema.pattern?.startsWith("^REV-")) return "REV-1";
  if (schema.pattern?.startsWith("^AC-")) return "AC-1";
  if (schema.pattern?.startsWith("^O[")) return "O1";
  if (schema.pattern?.startsWith("^[A-Za-z0-9]")) return "EXAMPLE-ID";
  return "<replace with the requested fact>";
}

/** Builds the role/task schema and transport instructions without fabricating
 * a new SE completion protocol or conferring any execution authority. */
export function agentSchemaDocument(entry, { action, subject } = {}) {
  let schema, format = "json_schema";
  if (entry.source) schema = bundle(document(new URL(entry.source, root)), new URL(entry.source, root));
  else if (entry.payload) {
    const url = new URL("governance/agent-exchange-payload.schema.json", root);
    schema = bundle(document(url).$defs[entry.payload], url);
  } else if (entry.request) {
    schema = agentExchangeResponseSchema({ kind: entry.request, recipient: { role: entry.role },
      payload: entry.evidence ? { purpose: "blocker_evidence", subject: subject ?? { commit_sha: "a".repeat(40), artifact_id: "<Node-issued artifact ID>" } } : {} });
    if (schema.properties.payload.properties.decision) {
      const decision = schema.properties.payload.properties.decision;
      if (action && !decision.properties.action.enum.includes(action)) throw Object.assign(new Error("Action is not allowed for this schema and role."), { code: "SCHEMA_ACTION_FORBIDDEN" });
      if (action) decision.properties.action.enum = [action];
      schema.properties.payload.properties.decision = { anyOf: agentDecisionBranches(decision) };
    } else if (action) throw Object.assign(new Error("This contract has no decision action."), { code: "SCHEMA_ACTION_FORBIDDEN" });
  } else if (entry.contract === "architecture_plan") {
    schema = structuredClone(ARCHITECTURE_PLAN_JSON_SCHEMA); format = "forge_field_contract";
  } else schema = { type: "string", minLength: 1, description: "Use the owner's requested text format; no structured completion envelope is required." };
  if (entry.envelope) schema = { type: "object", additionalProperties: false, required: ["kind", "subject", "payload", "evidence"], properties: {
    kind: { const: entry.payload }, subject: { type: "string", minLength: 1, maxLength: 500 }, payload: schema,
    evidence: { type: "array", maxItems: 0 } } };
  if (action && !entry.request) throw Object.assign(new Error("This contract has no decision action."), { code: "SCHEMA_ACTION_FORBIDDEN" });
  if (entry.draft) {
    const ticket = entry.draft === "sprint" ? schema.properties.tickets.items : schema;
    for (const key of ["project_id", "roadmap_id", "sprint_id", "status", "last_error", "provenance",
      "candidate_files", "candidates_produced_by", "candidates_produced_at", ...(entry.draft === "ticket" ? ["id"] : [])]) {
      delete ticket.properties[key];
      ticket.required = (ticket.required ?? []).filter((field) => field !== key);
    }
    delete ticket.properties.execution_policy.properties.max_review_revisions;
    ticket.required.push("verification_plan", "file_budget");
    if (entry.draft === "sprint") schema.required.push("human_plan");
  }
  const sample = entry.example ? structuredClone(entry.example) : format === "json_schema" ? example(schema) : null;
  if (entry.task === "candidate_result") sample.payload.candidate = example(schema.properties.payload.properties.candidate);
  const sampleTicket = entry.draft === "sprint" ? sample.tickets[0] : entry.draft === "ticket" ? sample : null;
  if (sampleTicket) sampleTicket.verification_plan[0].test_path = "backend/tests/unit/example.test.js";
  if (sample?.payload?.decision) {
    const decision = sample.payload.decision;
    sample.payload.outcome = AGENT_DECISION_OUTCOMES[decision.action];
    if (sample.payload.outcome === "needs_evidence") sample.payload.missing_evidence = [{ needed: "<Exact missing fact>", needed_for: "<Specific next decision>" }];
    if (sample.payload.outcome === "needs_higher_authority") sample.payload.consultation = {
      question: "<Focused question>", decision_needed: "<Required decision>", known_decision_refs: [], impact: "<Impact on the next step>" };
    if (["resolved", "sprint_required"].includes(decision.action)) {
      decision.authority_scope = entry.role === "architecture_manager" ? "architecture" : "sprint";
      decision.authority_reference = { passage_id: "<Exact Node-issued passage ID>", rationale: "<Why the passage authorizes this decision>" };
    }
  }
  const value = { schema_id: entry.schema_id, role: entry.role, task: entry.task, delivery: entry.delivery, purpose: entry.purpose,
    schema_format: format, schema, example: sample,
    rules: ["Read your role README before work; look up this contract before structured output.",
      "Replace example placeholders with inspected evidence and exact Node-issued identities. Examples confer no approval.",
      "Return only the documented transport fields. Correct formatting using retained evidence; do not restart discovery.",
      "Live authorization, source hashes, finding identities and execution binding remain checked by their owning services.",
      ...(entry.task === "architecture_plan" ? ["Return ONLY a single JSON object with the exact 10 required fields (title, objective, background, scope, outcomes, evidence, assumptions, constraints, risks, verification); never return Markdown plan files, unknown keys or null required fields. Arrays scope, outcomes, evidence, assumptions, outcomes[].acceptance_criteria and outcomes[].guardrails require at least 1 non-empty item (constraints and risks allow 0..40 items). Record prerequisite outcome dependencies (e.g. 'O1') as separate items in outcomes[].guardrails. Evidence path must start with backend/, schemas/, ui/, web/, docs/ or workflows/, and optional location must use ascending line ranges like L17-L75 or L17-L75; L98-L106. For plan updates, return an RFC 7396 JSON merge patch containing only changed fields (replace modified arrays in full, never set required root fields to null)."] : []),
      ...(entry.task === "review_result" ? ["New findings omit finding_id; finding_updates refer to exact persisted REV identities. Justify every affected file in per_file_necessity when files contains multiple paths. An approved verdict may retain only explicitly deferred minor findings. Request Node verification with verification_required and verification_requests; do not create findings until that evidence returns."] : []),
      ...(sample?.payload?.decision ? [`Consultation action/outcome mapping: ${JSON.stringify(AGENT_DECISION_OUTCOMES)}.`,
        "decision.evidence uses inspected {path,sha256} pairs (bare full-file SHA-256), separate from envelope evidence. Resolved, sprint_required and owner_required require 1-16 references; consultation/missing-evidence requests may omit decision.evidence or use []. Reuse retained read receipts; never invent evidence to ask another role a question."] : [])] };
  return { ...value, sha256: createHash("sha256").update(JSON.stringify(value)).digest("hex") };
}

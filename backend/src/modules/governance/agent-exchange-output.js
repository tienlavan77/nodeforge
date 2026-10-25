/** Projects the existing exchange contract into provider-native structured
 * output without transferring Node-owned routing or approval fields to a model.
 * Optional values use nullable slots for strict SDK schemas; decoding removes
 * only those omitted slots before the original Forge validators run. */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const envelope = require("../../../../schemas/governance/agent-exchange.schema.json");
const payloads = require("../../../../schemas/governance/agent-exchange-payload.schema.json");
const decisions = require("../../../../schemas/governance/agent-exchange-decision.schema.json");
const documents = { "agent-exchange.schema.json": envelope, "agent-exchange-payload.schema.json": payloads, "agent-exchange-decision.schema.json": decisions };

/** Resolves local contract references at construction time so SDKs need no
 * filesystem access, external schema fetching or independently maintained enums. */
function resolve(node, document) {
  if (!node.$ref) return { node, document };
  const [name, pointer] = node.$ref.split("#");
  const target = name ? documents[name] : document;
  if (!target) throw new Error(`Unknown agent exchange schema: ${name}.`);
  const value = (pointer ?? "").split("/").filter(Boolean).reduce((item, key) => item?.[key], target);
  if (!value) throw new Error(`Unknown agent exchange schema reference: ${node.$ref}.`);
  return resolve(value, target);
}

/** Bundles each canonical document in its own reference scope before composing
 * a response, preventing identically named evidence definitions from colliding. */
function inline(node, document) {
  if (Array.isArray(node)) return node.map((entry) => inline(entry, document));
  if (!node || typeof node !== "object") return node;
  ({ node, document } = resolve(node, document));
  return Object.fromEntries(Object.entries(node).filter(([key]) => !["$id", "$schema", "$defs", "$comment"].includes(key))
    .map(([key, value]) => [key, inline(value, document)]));
}

/** Distinguishes a meaningful null, such as a new file's checksum, from a
 * provider's placeholder for an optional property it did not supply. */
function nullable(node, document) {
  const resolved = resolve(node, document);
  return resolved.node.type === "null" || resolved.node.type?.includes?.("null")
    || (resolved.node.oneOf ?? resolved.node.anyOf ?? []).some((entry) => nullable(entry, resolved.document));
}

/** Keeps native generation within the common strict JSON Schema subset. Live
 * conditional authority and source checks remain enforced by Forge afterward. */
function project(node, document) {
  ({ node, document } = resolve(node, document));
  const result = Object.fromEntries(Object.entries(node).filter(([key]) => ["type", "enum", "description", "pattern", "minLength", "maxLength", "minimum", "maximum", "minItems", "maxItems"].includes(key)));
  if (node.const !== undefined) result.enum = [node.const];
  if (result.enum && !result.type) result.type = typeof result.enum[0];
  const choices = node.oneOf ?? node.anyOf;
  // Opaque reference objects have no native shape; generate their canonical
  // string alternative rather than empty objects that lose reference identity.
  if (choices) result.anyOf = choices.filter((entry) => {
    const child = resolve(entry, document).node;
    return child.type !== "object" || child.properties;
  }).map((entry) => project(entry, document));
  if (node.type === "object") {
    result.properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, child]) => {
      const projected = project(child, document);
      return [key, (node.required ?? []).includes(key) || nullable(child, document) ? projected : { anyOf: [projected, { type: "null" }] }];
    }));
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  if (node.items) result.items = project(node.items, document);
  return result;
}

/** Removes only SDK-generated optional null slots. Unknown fields and required
 * nulls are preserved so malformed or unauthorized responses still fail Forge. */
function normalize(value, node, document) {
  ({ node, document } = resolve(node, document));
  const choices = node.oneOf ?? node.anyOf;
  if (choices) {
    const branch = choices.find((entry) => {
      const type = resolve(entry, document).node.type;
      return type === (value === null ? "null" : Array.isArray(value) ? "array" : typeof value);
    });
    if (branch) return normalize(value, branch, document);
  }
  if (Array.isArray(value)) return value.map((entry) => node.items ? normalize(entry, node.items, document) : entry);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).flatMap(([key, entry]) => {
    const child = node.properties?.[key];
    if (!child) return [[key, entry]];
    if (entry === null && !(node.required ?? []).includes(key) && !nullable(child, document)) return [];
    return [[key, normalize(entry, child, document)]];
  }));
}

/** Defines the already-supported Coder proposal shape where the shared wire
 * schema deliberately delegates candidate details to the owning validator. */
function candidateSchema() {
  return { type: "object", additionalProperties: false, required: ["changes", "verification_steps"], properties: {
    changes: { type: "array", minItems: 1, items: { type: "object", additionalProperties: false, required: ["path", "sha256", "patch", "rationale"], properties: {
      path: { type: "string" }, sha256: { type: ["string", "null"] }, patch: { type: "string" }, rationale: { type: "string" } } } },
    verification_steps: { type: "array", minItems: 1, items: { type: "string" } } } };
}

/** Selects one request-bound response kind and subject for Claude/Codex native
 * generation. Native shape constraints supplement, never replace, live approval,
 * evidence, role and execution checks in the common exchange adapter. */
export function createAgentExchangeOutput(request) {
  const kind = { consultation_request: "consultation_response", work_request: "work_result", review_request: "review_result" }[request.kind];
  if (!kind) throw new Error("Agent exchange structured output requires a request kind.");
  const payload = inline(payloads.$defs[kind], payloads);
  if (kind === "consultation_response") {
    payload.required.push("decision");
    const decision = inline(decisions, decisions);
    const omitted = request.recipient.role === "architecture_manager" ? ["coder_request", "candidate_review", "criterion_updates"]
      : ["architecture_basis", "boundary_assessment", "escalation", "proposal", "contract_draft"];
    for (const key of omitted) delete decision.properties[key];
    for (const key of ["findings", "implementation_steps", "verification_steps"]) decision.properties.technical_result.properties[key].minItems = 1;
    decision.properties.technical_result.description = "Provide completed findings, remaining Coder implementation steps, focused verification steps and admission for every resolved technical handoff.";
    payload.properties.decision = decision;
  }
  if (kind === "work_result") payload.properties.candidate = candidateSchema();
  if (kind === "review_result" && request.payload.purpose === "blocker_evidence") {
    delete payload.properties.verdict;
    delete payload.properties.verification_requests;
    payload.required.push("purpose", "subject", "outcome", "observations", "missing_evidence");
    payload.properties.subject = { type: "object", additionalProperties: false, required: ["commit_sha", "artifact_id"],
      properties: { commit_sha: { const: request.payload.subject.commit_sha }, artifact_id: { const: request.payload.subject.artifact_id } } };
    payload.properties.findings.maxItems = 0; payload.properties.finding_updates.maxItems = 0;
    payload.properties.observations.minItems = 1; payload.properties.observations.maxItems = 16;
  }
  const canonical = { type: "object", additionalProperties: false, required: ["kind", "subject", "payload", "evidence"], properties: {
    kind: { const: kind }, subject: { type: "string", minLength: 1 }, payload, evidence: inline(envelope.properties.evidence, envelope) } };
  const schema = project(canonical, {});
  if (kind === "consultation_response") {
    const decision = payload.properties.decision;
    const resolved = { ...decision, required: [...decision.required, "technical_result"],
      properties: { ...decision.properties, action: { enum: ["resolved"] } } };
    const other = { ...decision, properties: { ...decision.properties,
      action: { enum: decision.properties.action.enum.filter((action) => action !== "resolved") } } };
    schema.properties.payload.properties.decision = { anyOf: [project(resolved, {}), project(other, {})] };
  }
  return { schema, normalize: (value) => normalize(value, canonical, {}) };
}

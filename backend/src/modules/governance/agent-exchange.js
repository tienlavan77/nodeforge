/** Defines the shared, versioned communication contract so Node routes explicit
 * agent intentions without interpreting narrative text or transferring approval. */
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const require = createRequire(import.meta.url);
const envelope = require("../../../../schemas/governance/agent-exchange.schema.json");
const payloads = require("../../../../schemas/governance/agent-exchange-payload.schema.json");
const decisionSchema = require("../../../../schemas/governance/agent-exchange-decision.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addSchema(envelope); ajv.addSchema(decisionSchema); ajv.addSchema(payloads);
const validateEnvelope = ajv.getSchema(envelope.$id);
const validators = new Map(envelope.properties.kind.enum.map((kind) => [kind, ajv.compile({ $ref: `${payloads.$id}#/$defs/${kind}` })]));
const higher = { coder: "sprint_leader", sprint_leader: "architecture_manager", architecture_manager: "project_owner" };
const requiredReply = { consultation_request: "consultation_response", work_request: "work_result", review_request: "review_result" };
const owned = ["schema_version", "message_id", "in_reply_to", "context", "sender", "recipient", "continuation"];

/** Reports exact contract errors for correction while leaving the pending
 * assignment and its checkpoint untouched. */
export function agentExchangeError(path, code, message) {
  return Object.assign(new Error(message), { code: "AGENT_EXCHANGE_INVALID", validation_errors: [{ path, reason: code, message }] });
}

/** Checks model-authored content at existing tool boundaries so adapters use
 * the same payload contract before Node assigns identities and recipients. */
export function assertAgentExchangePayload(kind, payload) {
  const validate = validators.get(kind);
  if (!validate) throw agentExchangeError("/kind", "kind_invalid", "Unknown agent exchange kind.");
  if (!validate(payload)) throw schemaError(validate.errors, "/payload");
  return payload;
}

/** Validates payload shape and role routes before any communication can trigger
 * execution, consultation, or an owner notification. Evidence is still verified by its owning service. */
export function assertAgentExchange(message) {
  if (!validateEnvelope(message)) throw schemaError(validateEnvelope.errors);
  if (message.message_id !== exchangeIdentity(message)) throw agentExchangeError("/message_id", "identity_mismatch", "Agent message content differs from its immutable identity.");
  assertAgentExchangePayload(message.kind, message.payload);
  const from = message.sender.role, to = message.recipient.role;
  if (["consultation_request", "work_request", "review_request", "correction"].includes(message.kind) && !message.recipient.agent_id) throw agentExchangeError("/recipient/agent_id", "recipient_required", "Node must resolve the recipient before dispatch.");
  let allowed = false;
  if (message.kind === "consultation_request") allowed = higher[from] === to;
  if (message.kind === "consultation_response") allowed = higher[to] === from;
  if (message.kind === "work_request") allowed = ["sprint_leader", "reviewer", "node"].includes(from) && to === "coder";
  if (message.kind === "work_result") allowed = from === "coder" && ["sprint_leader", "reviewer", "node"].includes(to);
  if (message.kind === "review_request") allowed = (message.payload.purpose === "blocker_evidence" ? from === "architecture_manager" : ["coder", "node"].includes(from)) && to === "reviewer";
  if (message.kind === "review_result") allowed = from === "reviewer" && (message.payload.purpose === "blocker_evidence" ? to === "architecture_manager" : ["coder", "node"].includes(to));
  if (message.kind === "correction") allowed = from === "node" && !["node", "project_owner"].includes(to);
  if (!allowed) throw agentExchangeError("/recipient", "route_forbidden", `Forbidden agent route: ${from} -> ${to} (${message.kind}).`);
  if (message.kind.endsWith("_response") || message.kind.endsWith("_result") || message.kind === "correction") {
    if (!message.in_reply_to) throw agentExchangeError("/in_reply_to", "reply_required", "A response must identify its request.");
  }
  if (to === "project_owner" && !ownerBoundaryRisk(message.payload)) throw agentExchangeError("/payload/owner_boundary_risk", "owner_boundary_required", "AM may consult Owner only for evidenced approved-scope or project-structure boundary risk.");
  if (message.kind === "consultation_response" && message.payload.outcome === "needs_higher_authority") {
    if (!higher[from]) throw agentExchangeError("/payload/outcome", "authority_unavailable", "This role has no consultation route.");
    if (from === "architecture_manager" && !ownerBoundaryRisk(message.payload.consultation)) throw agentExchangeError("/payload/consultation/owner_boundary_risk", "owner_boundary_required", "AM owner consultation requires evidence of an approved-scope or project-structure boundary.");
  }
  return message;
}

// Accepts the generalized owner boundary and legacy structure-only receipts.
function ownerBoundaryRisk(payload) {
  return Boolean(payload?.owner_boundary_risk || payload?.structure_change_risk);
}

/** Creates a deterministic immutable envelope from Node-authenticated identities;
 * identical retry delivery does not allocate a different communication identity. */
export function createAgentExchange({ context, sender, recipient, kind, subject, payload, evidence = [], continuation = null, inReplyTo = null }) {
  const body = { schema_version: "1", in_reply_to: inReplyTo, context, sender, recipient, kind, subject, payload, evidence, continuation };
  const message_id = exchangeIdentity(body);
  return assertAgentExchange({ ...structuredClone(body), message_id });
}

/** Accepts only the four model-authored fields, or a fully matching Node envelope,
 * and binds the response to the exact pending request before routing. */
export function bindAgentExchangeResponse(content, request) {
  assertAgentExchange(request);
  if (!content || typeof content !== "object" || Array.isArray(content)) throw agentExchangeError("/", "type", "Return one structured response object.");
  const kind = requiredReply[request.kind];
  const response = createAgentExchange({ context: request.context, sender: request.recipient, recipient: request.sender,
    kind: content.kind, subject: content.subject, payload: content.payload, evidence: content.evidence,
    continuation: request.continuation, inReplyTo: request.message_id });
  if (response.kind !== kind) throw agentExchangeError("/kind", "response_kind_mismatch", `Expected ${kind}.`);
  if (request.kind === "review_request" && (request.payload.purpose === "blocker_evidence" || response.payload.purpose === "blocker_evidence")
    && (request.payload.purpose !== response.payload.purpose || !isDeepStrictEqual(request.payload.subject, response.payload.subject)))
    throw agentExchangeError("/payload/subject", "binding_mismatch", "Evidence reports must match the requested purpose, commit and artifact.");
  if (content.schema_version !== undefined) {
    for (const key of owned) if (!isDeepStrictEqual(content[key], response[key])) throw agentExchangeError(`/${key}`, "binding_mismatch", `Node-owned ${key} cannot be replaced.`);
    assertAgentExchange(content);
  } else if (Object.keys(content).some((key) => !["kind", "subject", "payload", "evidence"].includes(key))) {
    throw agentExchangeError("/", "unexpected_field", "Return only kind, subject, payload and evidence.");
  }
  return response;
}

/** Translates JSON Schema paths into the same actionable correction format used
 * by the existing ticket recovery and independent review validators. */
function schemaError(errors, prefix = "") {
  const first = errors?.[0];
  const property = first?.params?.missingProperty ?? first?.params?.additionalProperty;
  const suffix = property ? `/${property.replace(/~/g, "~0").replace(/\//g, "~1")}` : "";
  const allowed = first?.params?.allowedValues;
  const expected = Array.isArray(allowed) ? ` Allowed values: ${JSON.stringify(allowed)}.` : "";
  return agentExchangeError(`${prefix}${first?.instancePath ?? ""}${suffix}`, first?.keyword ?? "schema_invalid", `${prefix || "Envelope"} ${first?.message ?? "is invalid"}.${expected}`);
}

/** Hashes canonical semantic content so retries share an identity independent of
 * object key order and altered stored bytes cannot impersonate a prior message. */
function exchangeIdentity(message) {
  const body = Object.fromEntries(Object.entries(message).filter(([key]) => key !== "message_id"));
  return `MSG-${createHash("sha256").update(JSON.stringify(body, (_, value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value)).digest("hex")}`;
}

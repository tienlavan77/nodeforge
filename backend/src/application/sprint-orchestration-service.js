// Orchestrates sprint execution across role agents with streamed output.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../shared/errors.js";
import { assertTicketVerificationContract } from "../modules/governance/ticket-verification-contract.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../../schemas/core/common.schema.json");
const ticketSchema = require("../../../schemas/governance/ticket.schema.json");
const sprintPlanSchema = require("../../../schemas/governance/sprint-plan.schema.json");

// Creates a service that orchestrates sprint execution across agents.
export function createSprintOrchestrationService({ sprintPlans, sprintPlanStore, ticketProvenanceTracker, agentGateway, publisher, agentRoles = ["sprint-leader"], streamBatchMs = 500, sprintPlanLeader, agentRoleResolver, draftPlan, sprintPlanDirectory } = {}) {
  if (typeof sprintPlans?.getSprintById !== "function") {
    throw new ConfigurationError("Sprint Orchestration requires Sprint Plans.");
  }
  const running = new Map();

  if (typeof agentGateway?.stream !== "function") throw new ConfigurationError("Sprint Orchestration requires the Real Agent Gateway.");
  if (typeof publisher?.publish !== "function") throw new ConfigurationError("Sprint Orchestration requires an Event Publisher.");
  if (!Number.isInteger(streamBatchMs) || streamBatchMs < 1) throw new ConfigurationError("Sprint Orchestration stream batch interval must be positive.");
  const validateSprintPlan = createSprintPlanValidator();
  return Object.freeze({ run, isRunning: (sprintId) => running.has(sprintId), ingestAgentCompletion });
  function run({ projectId, sprintId } = {}) {
    const sprint = sprintPlans.getSprintById(sprintId);
    if (!sprint || sprint.project_id !== projectId) throw new ConfigurationError(`Unknown Sprint Plan: ${sprintId}.`);
    if (running.has(sprintId)) {
      const error = new ConfigurationError(`Sprint is already running: ${sprintId}.`);
      error.statusCode = 409;
      throw error;
    }
    const sessionId = `SPRINT-${sprintId}-${randomUUID()}`;
    running.set(sprintId, sessionId);
    void runRealAgents({ projectId, sprint, sessionId }).finally(() => running.delete(sprintId));
    return { sprint_id: sprintId, session_id: sessionId, state: "RUNNING" };
  }
  async function ingestAgentCompletion({ message, agentId, text } = {}) {
    if (agentId !== "sprint-leader") return { ingested: false };
    let plan;
    try {
      plan = extractSprintPlanJson(text);
      const resolved = assignPlanTicketIdentity(stripPlanCandidateFields(plan), { projectId: message.project_id });
      assertSprintPlanGovernance(resolved);
      if (!validateSprintPlan(resolved)) throw new ConfigurationError(`Sprint Leader returned invalid sprint plan: ${validateSprintPlan.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
      await persistSprintPlan(resolved, { projectId: message.project_id, correlationId: message.correlation_id, conversationId: message.conversation_id, approvedParentPlanKey: message.approved_parent_plan_key });
      return { ingested: true, sprint_id: resolved.id };
    } catch (error) {
      publish("agent.failed", message.project_id, plan?.id ?? message.conversation_id, null, agentId, message.correlation_id, message.conversation_id, { role: agentId, error: `Sprint plan auto-ingest failed: ${error.message}` });
      return { ingested: false, error: error.message };
    }
  }
  async function runRealAgents({ projectId, sprint, sessionId }) {
    const tickets = sprint.tickets ?? [];
    for (const role of agentRoles.filter((entry) => entry === "sprint-leader")) {
      // Sprint leader drafts through the SDK with read-only project search; the
      // Coder owns implementation-path discovery and editing.
      if (role === "sprint-leader" && typeof sprintPlanLeader?.requestPlan === "function") {
        await runSprintLeaderSdk({ projectId, sprint, sessionId });
        continue;
      }
      const roleTickets = tickets.filter((ticket) => ticket.owner === role || !ticket.owner);
      const text = `${sprint.objective}\n\nTickets:\n${roleTickets.map((ticket) => `- ${ticket.id}: ${ticket.title} — ${ticket.objective}`).join("\n")}${role === "sprint-leader" ? "\n\nReturn ONLY a ```json block containing the sprint plan JSON valid against sprint-plan.schema.json (required: id, roadmap_id, project_id, objective, tickets[], exit_criteria, human_plan). human_plan must include outcome, in_scope, out_of_scope, approach, components, risks, assumptions, open_questions, evidence_refs and acceptance_criteria. Cite only evidence present in the brief. Every ticket MUST include exactly one implementation_type value (frontend|backend|security) and file_budget <= 4. Do NOT include style, candidate_files or candidate metadata. No prose outside the block." : ""}`;
      const correlationId = `CORR-${sprint.id}-${role}-${randomUUID()}`;
      const agentId = role;
      const conversationId = `CONV-${conversationRole(role)}-${sprint.id}`;
      publish("agent.started", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role });
      let output = "";
      let pending = "";
      let chunkIndex = 0;
      let timer;
      const flush = () => {
        if (!pending) return;
        const text = pending;
        pending = "";
        publish("agent.message.delta", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role, text, chunk_index: chunkIndex++ });
      };
      try {
        for await (const chunk of agentGateway.stream({ agentId, payload: { text, model: "claude-haiku-4-5", provider: "devquote" }, correlationId })) {
          if (!chunk.text) continue;
          output += chunk.text;
          pending += chunk.text;
          if (!timer) timer = setTimeout(() => { timer = undefined; flush(); }, streamBatchMs);
        }
        if (timer) { clearTimeout(timer); timer = undefined; }
        flush();
        if (role === "sprint-leader") {
          const plan = extractSprintPlanJson(output);
          const resolved = assignPlanTicketIdentity(stripPlanCandidateFields(plan), { projectId });
          assertSprintPlanGovernance(resolved);
          if (!validateSprintPlan(resolved)) throw new ConfigurationError(`Sprint Leader returned invalid sprint plan: ${validateSprintPlan.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
          await persistSprintPlan(resolved, { projectId, correlationId, conversationId });
        }
        publish("agent.token_used", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(output.length / 4) });
        publish("agent.completed", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role, text: output });
      } catch (error) {
        publish("agent.failed", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role, error: error.message });
      }
    }
  }
  // Runs the Sprint Leader over the SDK and strips file guesses from drafts.
  async function runSprintLeaderSdk({ projectId, sprint, sessionId }) {
    const correlationId = `CORR-${sprint.id}-sprint-leader-${randomUUID()}`;
    const conversationId = `CONV-SL-${sprint.id}`;
    publish("agent.started", projectId, sprint.id, sessionId, "sprint-leader", correlationId, conversationId, { role: "sprint-leader" });
    try {
      let agentId = "sprint-leader";
      try { agentId = agentRoleResolver.resolve("sprint_leader"); }
      // eslint-disable-next-line no-silent-catch -- The role ID is the configured fallback when profile lookup fails.
      catch { /* fall back to the role id */ }
      const plan = await sprintPlanLeader.requestPlan({ projectId, agentId, brief: buildSprintBrief(sprint), correlationId });
      const identified = assignPlanTicketIdentity(stripPlanCandidateFields(plan), { projectId });
      assertSprintPlanGovernance(identified);
      if (!validateSprintPlan(identified)) throw new ConfigurationError(`Sprint Leader returned invalid sprint plan: ${validateSprintPlan.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
      await persistSprintPlan(identified, { projectId, correlationId, conversationId });
      const text = JSON.stringify(identified);
      publish("agent.token_used", projectId, sprint.id, sessionId, "sprint-leader", correlationId, conversationId, { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(text.length / 4) });
      publish("agent.completed", projectId, sprint.id, sessionId, "sprint-leader", correlationId, conversationId, { role: "sprint-leader", text });
    } catch (error) {
      publish("agent.failed", projectId, sprint.id, sessionId, "sprint-leader", correlationId, conversationId, { role: "sprint-leader", error: error.message });
    }
  }
  // Summarizes the sprint so the leader can draft a plan with matching ids.
  function buildSprintBrief(sprint) {
    return JSON.stringify({ id: sprint.id, roadmap_id: sprint.roadmap_id, project_id: sprint.project_id, objective: sprint.objective, tickets: (sprint.tickets ?? []).map((ticket) => ({ id: ticket.id, title: ticket.title, objective: ticket.objective })), exit_criteria: sprint.exit_criteria ?? [] });
  }
  // Assigns identity fields the leader must not invent: ticket ids, parent
  // ids, and sprint_plan provenance, mirroring the CRUD create path.
  function assignPlanTicketIdentity(plan, { projectId } = {}) {
    if (!plan || typeof plan !== "object") return plan;
    const at = new Date().toISOString();
    const tickets = (Array.isArray(plan.tickets) ? plan.tickets : []).map((ticket) => {
      const entry = { ...(ticket ?? {}) };
      const id = entry.id;
      if (typeof id !== "string" || !/^TICKET-[A-Za-z0-9._-]+$/.test(id)) throw Object.assign(new ConfigurationError("Sprint Leader must create a valid ticket ID for every ticket."), { code: "SPRINT_TICKET_ID_INVALID", statusCode: 422 });
      return {
        ...entry,
        id,
        project_id: projectId,
        roadmap_id: entry.roadmap_id ?? plan.roadmap_id,
        sprint_id: entry.sprint_id ?? plan.id,
        provenance: entry.provenance ?? { source: "sprint_plan", source_id: plan.id, created_at: at }
      };
    });
    const ids = new Set(tickets.map((ticket) => ticket.id));
    if (ids.size !== tickets.length) throw Object.assign(new ConfigurationError("Sprint Leader ticket IDs must be unique."), { code: "SPRINT_TICKET_ID_DUPLICATE", statusCode: 422 });
    for (const ticket of tickets) for (const dependency of ticket.dependencies ?? []) if (!ids.has(dependency)) throw Object.assign(new ConfigurationError(`Ticket ${ticket.id} has an unknown dependency: ${dependency}.`), { code: "SPRINT_TICKET_DEPENDENCY_INVALID", statusCode: 422 });
    return { ...plan, tickets };
  }
  function conversationRole(role) {
    return { "architecture-manager": "AM", "sprint-leader": "SL", builder: "BU", reviewer: "RV" }[role] ?? role.toUpperCase();
  }
  async function persistSprintPlan(plan, trace = {}) {
    if (typeof sprintPlanStore?.save !== "function") return;
    if (typeof draftPlan !== "function") throw new ConfigurationError("Sprint Leader requires immutable plan drafting before publishing a sprint.");
    const draft = await draftPlan(plan, trace);
    const timestamp = new Date().toISOString();
    const current = sprintPlanStore.getCurrent?.();
    const retained = current?.project_id === plan.project_id ? current.sprints?.filter((sprint) => sprint.id !== plan.id) ?? [] : [];
    sprintPlanStore.save({ id: plan.roadmap_id, project_id: plan.project_id, version: `${plan.id}-projection-${randomUUID()}`, created_at: timestamp, updated_at: timestamp, ...(current?.architecture_decision_ids?.length ? { architecture_decision_ids: current.architecture_decision_ids } : {}), sprints: [...retained, plan] });
    persistSprintPlanArtifact(plan, sprintPlanDirectory);
    if (current?.architecture_decision_ids?.length) {
      for (const ticket of plan.tickets) ticketProvenanceTracker?.registerTicket?.(ticket);
    } else {
      publish("governance.sprint_plan.provenance_pending", plan.project_id, plan.id, null, "sprint-leader", trace.correlationId ?? null, trace.conversationId ?? null, { plan_id: draft.plan_id, revision: draft.revision, reason: "No approved architecture decision is linked to this roadmap; human plan approval remains required." });
    }
    publish("governance.sprint_plan.created", plan.project_id, plan.id, null, "sprint-leader", trace.correlationId ?? null, trace.conversationId ?? null, { sprint_plan: plan, plan_id: draft.plan_id, revision: draft.revision, sha256: draft.sha256, status: draft.status ?? "awaiting_human_approval" });
  }
  function publish(type, projectId, taskId, sessionId, agentId, correlationId, conversationId, payload) {
    publisher.publish({ event_id: `EVT-${randomUUID()}`, type, project_id: projectId, task_id: taskId, timestamp: new Date().toISOString(), payload, metadata: { source: "real-agent-orchestration", session_id: sessionId, agent_id: agentId, correlation_id: correlationId, conversation_id: conversationId } });
  }

}

// Removes obsolete candidate metadata before a Sprint Leader plan is persisted.
function stripPlanCandidateFields(plan) {
  if (!plan || typeof plan !== "object" || !Array.isArray(plan.tickets)) return plan;
  return {
    ...plan,
    tickets: plan.tickets.map((ticket) => {
      const clean = { ...(ticket ?? {}) };
      delete clean.candidate_files;
      delete clean.candidates_produced_by;
      delete clean.candidates_produced_at;
      return clean;
    })
  };
}

// Persists the generated Sprint Plan as a human-readable runtime artifact for UI and audit inspection.
function persistSprintPlanArtifact(plan, directory) {
  if (typeof directory !== "string" || !directory.trim()) return;
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${plan.id}.json`), `${JSON.stringify(plan, null, 2)}\n`);
}

// Extracts sprint plan JSON from a fenced code block.
export function extractSprintPlanJson(text) {
  const match = String(text ?? "").match(/^\s*```json\s*([\s\S]*?)\s*```\s*$/i);
  if (!match) throw new ConfigurationError("Sprint Leader response must contain exactly one ```json fenced block.");
  try { return JSON.parse(match[1]); } catch (error) { throw new ConfigurationError(`Sprint Leader JSON block is invalid: ${error.message}`); }
}

// Creates a JSON schema validator for sprint plans.
function createSprintPlanValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema).addSchema(sprintPlanSchema);
  return ajv.getSchema(sprintPlanSchema.$id);
}

// Enforces one ticket implementation type and the bounded file budget before persistence.
function assertSprintPlanGovernance(plan) {
  for (const ticket of plan?.tickets ?? []) {
    if (!Array.isArray(ticket.implementation_type) || ticket.implementation_type.length !== 1 || !["frontend", "backend", "security"].includes(ticket.implementation_type[0]) || ticket.style !== undefined) throw Object.assign(new ConfigurationError(`Ticket ${ticket.id ?? "<unknown>"} must declare exactly one implementation_type.`), { code: "SPRINT_TICKET_IMPLEMENTATION_TYPE_INVALID", statusCode: 422 });
    if (!Number.isInteger(ticket.file_budget) || ticket.file_budget < 1 || ticket.file_budget > 4) throw Object.assign(new ConfigurationError(`Ticket ${ticket.id ?? "<unknown>"} must declare file_budget from 1 to 4.`), { code: "SPRINT_TICKET_FILE_BUDGET_INVALID", statusCode: 422 });
    assertTicketVerificationContract(ticket);
  }
}

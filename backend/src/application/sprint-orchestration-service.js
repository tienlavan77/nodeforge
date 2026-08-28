import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { ConfigurationError } from "../shared/errors.js";

const require = createRequire(import.meta.url);
const commonSchema = require("../../schemas/core/common.schema.json");
const ticketSchema = require("../../schemas/governance/ticket.schema.json");
const sprintPlanSchema = require("../../schemas/governance/sprint-plan.schema.json");

export function createSprintOrchestrationService({ runtimeService, sprintPlans, sprintPlanStore, ticketProvenanceTracker, agentGateway, publisher, agentRoles = ["architecture-manager", "sprint-leader", "builder", "reviewer"], streamBatchMs = 500 } = {}) {
  if (typeof runtimeService?.startTask !== "function" || typeof sprintPlans?.getSprintById !== "function") {
    throw new ConfigurationError("Sprint Orchestration requires Runtime Service and Sprint Plans.");
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
    const sessionId = `SESSION-${sprintId}-${randomUUID()}`;
    const session = runtimeService.startTask({ projectId, taskId: sprintId, sessionId, query: sprint.objective, domain: "sprint", runAgent: false });
    running.set(sprintId, sessionId);
    void runRealAgents({ projectId, sprint, sessionId }).finally(() => running.delete(sprintId));
    return { sprint_id: sprintId, session_id: session.id, state: session.state };
  }

  async function ingestAgentCompletion({ message, agentId, text } = {}) {
    if (agentId !== "sprint-leader") return { ingested: false };
    let plan;
    try {
      plan = extractSprintPlanJson(text);
      if (!validateSprintPlan(plan)) throw new ConfigurationError(`Sprint Leader returned invalid sprint plan: ${validateSprintPlan.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
      persistSprintPlan(plan, { projectId: message.project_id, correlationId: message.correlation_id, conversationId: message.conversation_id });
      return { ingested: true, sprint_id: plan.id };
    } catch (error) {
      publish("agent.failed", message.project_id, plan?.id ?? message.conversation_id, null, agentId, message.correlation_id, message.conversation_id, { role: agentId, error: `Sprint plan auto-ingest failed: ${error.message}` });
      return { ingested: false, error: error.message };
    }
  }

  async function runRealAgents({ projectId, sprint, sessionId }) {
    const tickets = sprint.tickets ?? [];
    let failed = false;
    for (const role of agentRoles) {
      const roleTickets = tickets.filter((ticket) => ticket.owner === role || !ticket.owner);
      const text = `${sprint.objective}\n\nTickets:\n${roleTickets.map((ticket) => `- ${ticket.id}: ${ticket.title} — ${ticket.objective}`).join("\n")}${role === "sprint-leader" ? "\n\nReturn ONLY a ```json block containing the sprint plan JSON valid against sprint-plan.schema.json (required: id, roadmap_id, project_id, objective, tickets[], exit_criteria). No prose outside the block." : ""}`;
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
          if (!validateSprintPlan(plan)) throw new ConfigurationError(`Sprint Leader returned invalid sprint plan: ${validateSprintPlan.errors.map((error) => `${error.instancePath || "/"} ${error.message}`).join("; ")}`);
          persistSprintPlan(plan, { projectId, correlationId, conversationId });
        }
        publish("agent.token_used", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { input_tokens: Math.ceil(text.length / 4), output_tokens: Math.ceil(output.length / 4) });
        publish("agent.completed", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role, text: output });
      } catch (error) {
        failed = true;
        publish("agent.failed", projectId, sprint.id, sessionId, agentId, correlationId, conversationId, { role, error: error.message });
      }
    }
    runtimeService.finishTask(sessionId, { failed });
  }

  function conversationRole(role) {
    return { "architecture-manager": "AM", "sprint-leader": "SL", builder: "BU", reviewer: "RV" }[role] ?? role.toUpperCase();
  }

  function persistSprintPlan(plan, trace = {}) {
    if (typeof sprintPlanStore?.save !== "function") return;
    if (sprintPlanStore.getAllVersions?.().some((roadmap) => roadmap.sprints?.some(({ id }) => id === plan.id))) {
      const error = new ConfigurationError(`Sprint already exists: ${plan.id}.`);
      error.statusCode = 409;
      throw error;
    }
    const timestamp = new Date().toISOString();
    sprintPlanStore.save({ id: plan.roadmap_id, project_id: plan.project_id, version: plan.id, created_at: timestamp, updated_at: timestamp, sprints: [plan] });
    for (const ticket of plan.tickets) ticketProvenanceTracker?.registerTicket?.(ticket);
    publish("governance.sprint_plan.created", plan.project_id, plan.id, null, "sprint-leader", trace.correlationId ?? null, trace.conversationId ?? null, { sprint_plan: plan });
  }

  function publish(type, projectId, taskId, sessionId, agentId, correlationId, conversationId, payload) {
    publisher.publish({ event_id: `EVT-${randomUUID()}`, type, project_id: projectId, task_id: taskId, timestamp: new Date().toISOString(), payload, metadata: { source: "real-agent-orchestration", session_id: sessionId, agent_id: agentId, correlation_id: correlationId, conversation_id: conversationId } });
  }

}

export function extractSprintPlanJson(text) {
  const match = String(text ?? "").match(/^\s*```json\s*([\s\S]*?)\s*```\s*$/i);
  if (!match) throw new ConfigurationError("Sprint Leader response must contain exactly one ```json fenced block.");
  try { return JSON.parse(match[1]); } catch (error) { throw new ConfigurationError(`Sprint Leader JSON block is invalid: ${error.message}`); }
}

function createSprintPlanValidator() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  ajv.addSchema(commonSchema).addSchema(ticketSchema).addSchema(sprintPlanSchema);
  return ajv.getSchema(sprintPlanSchema.$id);
}

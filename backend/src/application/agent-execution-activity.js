// Publishes project-scoped execution lifecycle so Coding panels open for actual Sprint Leader, Coder, and Reviewer work.
import { randomUUID } from "node:crypto";
import { ConfigurationError } from "../shared/errors.js";

// Emits bounded activity without exposing prompts or allowing monitor failures to interrupt agent execution.
export function createAgentExecutionActivity({ projectId, eventBus, logger = console }) {
  if (!projectId || typeof eventBus?.emit !== "function") throw new ConfigurationError("Agent execution activity requires a project and event bus.");
  const active = new Map();
  const recent = new Map();
  // Defines publish function behavior for agent-execution-activity.js.
  const publish = ({ agentId, correlationId, phase, summary, toolName, project_id }) => {
    if (project_id !== undefined && project_id !== projectId) return;
    if (typeof agentId !== "string" || !agentId || typeof correlationId !== "string" || !correlationId || !["started", "completed", "failed", "tool_started", "tool_completed", "tool_failed"].includes(phase)) return;
    const event = { event_id: `EVT-${randomUUID()}`, event_type: "agent.activity", project_id: projectId, correlation_id: correlationId, timestamp: new Date().toISOString(),
      payload: { agent_id: agentId, correlation_id: correlationId, activity_type: phase, status: ["started", "tool_started"].includes(phase) ? "working" : ["failed", "tool_failed"].includes(phase) ? "failed" : "success",
        summary: (summary ?? `Agent execution ${phase}.`).slice(0, 500), ...(toolName ? { tool_name: toolName.slice(0, 100) } : {}) } };
    const key = JSON.stringify([agentId, correlationId]);
    if (phase === "started") { active.set(key, event); recent.set(key, []); }
    else if (phase.startsWith("tool_")) {
      if (active.has(key)) recent.set(key, [...(recent.get(key) ?? []), event].slice(-20));
    } else { active.delete(key); recent.delete(key); }
    try { eventBus.emit("agent.activity", event); }
    catch (error) { logger.error("Agent execution activity publication failed.", { agent_id: agentId, correlation_id: correlationId, error: error.message }); }
  };
  publish.snapshot = () => structuredClone([...active.entries()].flatMap(([key, event]) => [event, ...(recent.get(key) ?? [])]));
  // Surface audited agent tools without exposing their arguments, source contents, or result payloads.
  publish.recordToolEvent = (entry = {}) => {
    if (entry.project_id !== undefined && entry.project_id !== projectId) return;
    if (["ticket.verification_waiting", "ticket.verification_wait_finished"].includes(entry.event_name)) {
      publish({ agentId: entry.payload?.agent_id, correlationId: entry.correlation_id, phase: "tool_started", toolName: "report_done", summary: entry.message });
      return;
    }
    if (entry.event_name === "supervisor.approval_retry_scheduled") {
      publish({ agentId: entry.payload?.agent_id, correlationId: entry.correlation_id, phase: "tool_started", toolName: "approval_review", summary: entry.message });
      return;
    }
    const triagePhase = { started: "started", success: "completed", failed: "failed", blocked: "failed" }[entry.status];
    if (["supervisor.blocker_triage_started", "supervisor.blocker_triage_finished"].includes(entry.event_name)) {
      const agentId = entry.payload?.agent_id;
      const correlationId = entry.correlation_id ?? (entry.payload?.job_id || entry.task_id ? `BLOCKER-${entry.payload?.job_id ?? entry.task_id}` : null);
      if (typeof agentId === "string" && agentId && correlationId && triagePhase) publish({ agentId, correlationId, phase: triagePhase, summary: entry.message });
      return;
    }
    if (!["forge.tool_started", "forge.tool_success", "forge.tool_failed", "sprint_leader.tool_call", "review.tool_call",
      "supervisor.agent_tool_event", "agent.tool_call", "agent.tool_result", "supervisor.blocker_tool_call"].includes(entry.event_name)) return;
    const agentId = entry.payload?.agent_id;
    const toolName = entry.payload?.tool;
    const phase = { started: "tool_started", success: "tool_completed", failed: "tool_failed" }[entry.status];
    if (typeof agentId !== "string" || typeof toolName !== "string" || !phase) return;
    const running = [...active.values()].filter((event) => event.payload.agent_id === agentId);
    const suppliedCorrelation = entry.correlation_id ?? entry.payload?.execution_id;
    const run = running.find((event) => event.correlation_id === suppliedCorrelation) ?? (running.length === 1 ? running[0] : null);
    const correlationId = run?.correlation_id ?? suppliedCorrelation;
    const code = entry.error_code ?? entry.payload?.error_code ?? entry.payload?.error?.code;
    const errorCode = entry.status === "failed" && typeof code === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(code) ? code : null;
    const pending = toolName === "report_done" && errorCode === "VERIFY_RECOVERY_PENDING";
    const summary = pending ? "Node verification is still running; wait for Node to return the result."
      : `Agent tool ${toolName.slice(0, 100)} ${entry.status}${errorCode ? ` (${errorCode})` : ""}.`;
    publish({ agentId, correlationId, phase: pending ? "tool_started" : phase, toolName, summary });
  };
  return publish;
}

// Preserve project audit logging while forwarding safe tool activity to live Coding panels.
export function createAgentActivityLogger({ logEvent, executionActivity }) {
  return (entry) => {
    executionActivity.recordToolEvent(entry);
    return logEvent?.(entry);
  };
}

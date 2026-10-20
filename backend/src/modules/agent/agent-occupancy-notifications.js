// Publishes shared-agent status and failure logs using durable claim ownership rather than startup context.
import { randomUUID } from "node:crypto";

// Connects occupancy transitions to project history, activity, and diagnostics without reattributing legacy rows.
export function createAgentOccupancyNotifications({ projectId, logEvent, internalBus, executionActivity, eventPublisher }) {
  return {
    logger: { error: (_message, details) => logEvent({ timestamp: new Date().toISOString(), event_name: "agent.occupancy_notification_failed", level: "error", status: "failed", message: "Agent occupancy post-commit notification failed.", task_id: details.task_id, project_id: details.project_id ?? projectId, source: "agent-occupancy-store", error_code: "OCCUPANCY_NOTIFICATION_FAILED", payload: details }) },
    onChanged: async (claim) => {
      const timestamp = new Date().toISOString();
      const claimProjectId = claim.project_id ?? projectId;
      const event = { event_id: `EVT-${randomUUID()}`, type: "agent.status_changed", project_id: claimProjectId, timestamp, task_id: claim.task_id, agent_id: claim.agent_id,
        payload: { project_id: claim.project_id ?? null, agent_id: claim.agent_id, status: claim.status, previous_status: claim.previous_status, task_id: claim.task_id, supervisor_id: claim.supervisor_id, claim_id: claim.claim_id, reason: claim.release_reason ?? null, updated_at: timestamp },
        metadata: { project_id: claimProjectId, task_id: claim.task_id, source: "agent-occupancy-store" } };
      internalBus.emit("agent.status_changed", event);
      executionActivity({ project_id: claimProjectId, agentId: claim.agent_id, correlationId: claim.claim_id, phase: claim.status === "working" ? "started" : "completed", summary: claim.status === "working" ? "Agent claimed ticket execution." : "Agent execution claim released; ticket outcome is tracked separately." });
      await eventPublisher.publish(event);
    }
  };
}

// Subscribes each agent's conversation to its live SSE stream and reconciles working-status, history-delta, and dashboard-refresh side effects.

import { useEffect } from "react";
import { AGENTS, PROJECT_ID, CONVERSATIONS } from "./node-forge-app-constants.js";

// Wires one live conversation stream per agent for the NodeForge app shell.
export function useAgentEventStreams({
  client,
  lastMessageId,
  setWorkingByAgent,
  queueHistoryDelta,
  finalizeHistoryDelta,
  pushLiveHistory,
  sseReplayRef,
  scheduleDashboardRefresh,
  loadWorkspace,
  loadDashboard,
  dashboardRefreshTimerRef
}) {
  useEffect(() => {
    loadWorkspace();
    loadDashboard();
    const streams = AGENTS.map((agent) => {
      const conversationId = CONVERSATIONS[agent.id];
      return client.connectConversationStream({
        projectId: PROJECT_ID,
        conversationId,
        afterMessageId: lastMessageId.current[agent.id],
        onMessage: (message) => {
          lastMessageId.current[agent.id] = message.message_id;
          if (message.message_type === "node.status_change" && message.payload?.to === "running" && agent.id === "builder") {
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: "WORKING" }));
          }
          if (message.message_type === "node.status_change" && ["done", "failed", "reviewing"].includes(message.payload?.to) && agent.id === "builder") {
            setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload.to === "failed" ? "FAILED" : message.payload.to === "reviewing" ? "REVIEWING" : "READY" }));
          }
          if (message.message_type.endsWith(".message.received") || message.message_type.endsWith(".error")) setWorkingByAgent((prev) => ({ ...prev, [agent.id]: message.payload?.agent_status ?? (message.message_type.endsWith(".error") ? "FAILED" : "COMPLETED") }));
          if (message.message_type.endsWith(".message.delta")) {
            queueHistoryDelta(agent.id, message);
          } else if (message.message_type.endsWith(".message.received")) {
            finalizeHistoryDelta(agent.id, message);
            pushLiveHistory(agent.id, message);
          } else {
            pushLiveHistory(agent.id, message);
          }
          if (!sseReplayRef.current[agent.id] && (message.message_type === "governance.sprint_plan.created" || message.message_type === "ticket.creation")) scheduleDashboardRefresh();
          if (!sseReplayRef.current[agent.id] && message.message_type === "node.status_change" && message.payload?.ticket_id) {
            // SSE is a live signal only; API remains the canonical ticket source.
            scheduleDashboardRefresh();
          }
          if (agent.id === "architecture-manager" && message.message_type === "architecture.message.received") loadWorkspace();
        },
        onReplayComplete: () => {
          sseReplayRef.current[agent.id] = false;
          setWorkingByAgent((prev) => ({ ...prev, [agent.id]: prev[agent.id] === "WORKING" ? "READY" : prev[agent.id] }));
        }
      });
    });
    return () => {
      streams.forEach((stream) => stream.close());
      if (dashboardRefreshTimerRef.current) clearTimeout(dashboardRefreshTimerRef.current);
      dashboardRefreshTimerRef.current = null;
    };
  }, [client, loadDashboard, loadWorkspace, scheduleDashboardRefresh]);
}

// Supplies controlled directory and stream boundaries while the real Coding page manages persisted panel presence.
import { useEffect } from "react";
import { flushSync } from "react-dom";

export const PROJECT_ID = "PROJECT-BROWSER";
export const profiles = ["coder-1", "coder-2"].map((agent_id) => ({ agent_id, agent_name: "Same name", role: "coder", status: "ready" }));
let stream;

// Replaces only external I/O; panel state, effects, rendering and browser storage remain production code.
export function createNodeClient() {
  return {
    getAgents: () => window.presenceFixture?.holdDirectory
      ? new Promise((resolve) => { window.presenceFixture.releaseDirectory = () => resolve(profiles); }) : Promise.resolve(profiles),
    getProjectDashboard: async () => ({ project_id: PROJECT_ID, roadmap: { sprints: [] } }),
    listPlans: async () => [], listPlanRequests: async () => [], listCodeCheckpoints: async () => ({ checkpoints: [] }),
    connectProjectStream: () => ({ close() {} })
  };
}

// Feeds the existing shared fifty-item buffer and exact delivery callback without launching real agents.
export function deliverPresenceEvents(events, source) {
  if (!stream) throw new Error("Coding stream fixture is not mounted.");
  flushSync(() => {
    if (source) stream.setWatcherState(source);
    for (const event of events) stream.onProjectEvent(event);
    stream.setAgentActivities(events.slice(-50));
  });
}

// Connects a controlled source to the page's real event callbacks, including buffered delivery during mount.
export function useProjectEventStream(options) {
  stream = options;
  useEffect(() => {
    options.setWatcherState("connected");
    const buffered = window.presenceFixture?.buffered ?? [];
    for (const event of buffered) options.onProjectEvent(event);
    options.setAgentActivities(buffered.slice(-50));
    return () => { stream = null; };
  }, []);
}

// Omits unrelated navigation chrome while retaining the complete Coding page under test.
export function ConversationSidebar() { return null; }

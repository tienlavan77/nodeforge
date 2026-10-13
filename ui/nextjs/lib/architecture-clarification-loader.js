// Restores conversation planning questions on actual lifecycle events and tab return without active-tab polling.

// Loads current clarification sessions and ignores superseded responses across conversations or reloads.
export function createArchitectureClarificationLoader({ client, projectId, conversationId, onState }) {
  let generation = 0;
  let state = { status: "loading", sessions: [], error: null };
  return { load, cancel: () => { generation += 1; } };

  // Reconciles Node-owned pending answers without fetching every Architecture plan document.
  async function load() {
    const request = ++generation;
    try {
      const sessions = await client.listArchitectureClarifications(projectId, conversationId);
      if (request !== generation) return;
      state = { status: "ready", sessions, error: null };
    } catch (error) {
      if (request !== generation) return;
      state = { ...state, status: "error", error: error.message };
    }
    onState(state);
  }
}

// Restricts refresh to planning results, selected-conversation completions and reconnects rather than chat deltas or ticket noise.
export function refreshArchitectureClarifications(event, projectId, conversationId) {
  if (event.project_id !== projectId) return false;
  if (event.event_type === "stream.connected" || event.event_type?.startsWith("plan.request.")) return true;
  return ["conversation.message.received", "conversation.message.completed", "conversation.message.failed"].includes(event.event_type) && event.payload?.conversation_id === conversationId;
}

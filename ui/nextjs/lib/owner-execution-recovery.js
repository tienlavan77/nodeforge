// Refreshes owner recovery controls after Escape interrupts work, independently of message typing or retry.

// Watches the durable stop checkpoint without overlapping requests or updating an abandoned conversation.
export function watchOwnerExecutionRecovery({ client, projectId, conversationId, executionId, onUpdate, onError, schedule = setTimeout, cancel = clearTimeout }) {
  let disposed = false;
  let timer;
  // Reads server-authorized actions again until the component leaves its pending recovery lifecycle.
  async function refresh() {
    try {
      const response = await client.listOwnerExecutions(projectId, conversationId);
      if (disposed) return;
      onUpdate((response.items ?? []).map((entry) => entry.execution_id === executionId && entry.status === "running" ? { ...entry, status: "pausing" } : entry));
    } catch (error) {
      if (!disposed) onError(error.message ?? "Unable to refresh execution recovery options.");
    } finally {
      if (!disposed) timer = schedule(refresh, 500);
    }
  }
  void refresh();
  // Cancels the pending refresh and ignores a response after navigation or recovery readiness.
  return function stop() {
    disposed = true;
    if (timer !== undefined) cancel(timer);
  };
}

// Keeps recovery pending until the server exposes an action, including the runner-stop persistence window.
export function awaitingOwnerExecutionRecovery(record) {
  return record?.status === "pausing" || (["interrupted", "manual_required"].includes(record?.status)
    && !["can_continue", "can_restart", "can_discard", "can_reconcile"].some((key) => record[key]));
}

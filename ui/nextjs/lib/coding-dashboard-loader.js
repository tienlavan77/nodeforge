// Loads Coding Sprint scope without hiding diagnostics or automatically retrying reconciliation conflicts.
import { normalizeUiError } from "./ui-error.js";

// Keeps the active Coding consumer's loading, available, and unavailable states distinct.
export function createCodingDashboardLoader({ client, projectId, onState, logger = console.error }) {
  let generation = 0;
  let lastError = null;
  return { load, cancel };

  // Ignores stale responses and stream refreshes after a non-retryable conflict; explicit reads may resume later.
  async function load({ manual = false } = {}) {
    if (!manual && lastError?.retryable === false) return;
    const current = ++generation;
    onState({ status: "loading", dashboard: null, error: null });
    try {
      const dashboard = await client.getProjectDashboard(projectId);
      if (current !== generation) return;
      if (dashboard?.project_id !== projectId) throw Object.assign(new Error("Dashboard response belongs to a different project."), { code: "PROJECT_CONTEXT_CONFLICT", retryable: false, scope: "scoped" });
      lastError = null;
      onState({ status: "ready", dashboard, error: null });
    } catch (error) {
      logger("Unable to load coding sprint dashboard", error);
      if (current !== generation) return;
      lastError = normalizeUiError(error, { fallback: "Sprint Plan is unavailable." });
      onState({ status: "error", dashboard: null, error: lastError });
    }
  }

  // Invalidates in-flight reads when the Coding page unmounts without permanently disabling remounts.
  function cancel() { generation += 1; }
}

// Loads authoritative Architecture plans independently from Sprint dashboard and conversation state.

// Keeps plan selection stable while excluding superseded, rejected and completed handoffs.
export function reviewableArchitecturePlans(plans) {
  return plans.filter((plan) => plan.format === "markdown" && (plan.status === "awaiting_human_approval" || plan.status === "approved" && (plan.handoff_status !== "completed" || plan.readiness_status !== "established")))
    .sort((left, right) => String(right.created_at ?? "").localeCompare(String(left.created_at ?? "")) || left.plan_id.localeCompare(right.plan_id));
}

// Refetches current revisions and ignores responses from cancelled or superseded requests.
export function createCodingPlanLoader({ client, projectId, onState }) {
  let generation = 0;
  let snapshot = { status: "loading", plans: [], error: null };
  return { load, cancel: () => { generation += 1; } };

  // Reconciles plan-store authority without requiring a Sprint ID or reloading the Sprint dashboard.
  async function load() {
    const request = ++generation;
    try {
      const [listed, diagnostics] = await Promise.all([client.listPlans(projectId), Promise.resolve().then(() => client.listPlanRequests?.(projectId) ?? []).then((requests) => ({ requests, error: null }), (error) => ({ requests: [], error: error.code ?? "PLAN_DIAGNOSTICS_UNAVAILABLE" }))]);
      const requests = diagnostics.requests;
      const heads = listed.filter((head) => head.format === "markdown");
      const plans = await Promise.all(heads.map((head) => client.getPlanRevision(projectId, head.plan_id, head.revision)));
      if (request !== generation) return;
      snapshot = { status: "ready", plans: reviewableArchitecturePlans(plans), requests, diagnostics_error_code: diagnostics.error, error: null };
    } catch (error) {
      if (request !== generation) return;
      snapshot = { ...snapshot, status: "error", error: error.message };
    }
    onState(snapshot);
  }
}

// Extracts a display name from immutable Markdown without changing artifact bytes or checksum.
export function architecturePlanName(plan) { return plan.markdown?.match(/^# Plan:\s*(.+)$/m)?.[1]?.trim() || plan.plan_id; }

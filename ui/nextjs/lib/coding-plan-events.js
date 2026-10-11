// Fans out the existing Coding project stream to plan components without opening another network connection.

// Reduces bounded progress history without letting duplicates or delayed generating events regress a terminal state.
export function applyCodingPlanLifecycle(current, event, projectId) {
  if (event.project_id !== projectId || !["plan.request.generating", "plan.request.persisted", "plan.request.failed"].includes(event.event_type)) return current;
  const payload = event.payload ?? {};
  if (typeof payload.request_id !== "string" || !/^[A-Za-z0-9_-]+$/.test(payload.request_id)) return current;
  const status = event.event_type.slice("plan.request.".length);
  const prior = current[payload.request_id];
  if (prior && prior.status !== "generating") return current;
  if (status === "persisted" && (!Number.isSafeInteger(payload.revision) || payload.revision < 1 || !/^[a-f0-9]{64}$/.test(payload.sha256 ?? "") || !/^[A-Za-z0-9._-]+$/.test(payload.plan_id ?? ""))) return current;
  if (status === "failed" && !/^[A-Z][A-Z0-9_]{0,79}$/.test(payload.error_code ?? "")) return current;
  const next = { ...current, [payload.request_id]: { request_id: payload.request_id, status, observed_generating: prior?.observed_generating === true || status === "generating", ...(status === "failed" ? { error_code: payload.error_code } : {}) } };
  return Object.fromEntries(Object.entries(next).slice(-50));
}

// Shares lifecycle and reconnect triggers with project-isolated subscribers; it grants no approval authority.
export function createCodingPlanEvents(projectId) {
  const listeners = new Set();
  return {
    publish(event) {
      if (event.project_id !== projectId) return;
      for (const listener of listeners) listener(event);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
}

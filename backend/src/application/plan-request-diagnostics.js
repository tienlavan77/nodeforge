// Keeps owner plan creation authoritative when optional request diagnostics are unavailable.
import { randomUUID } from "node:crypto";

// Records diagnostic transitions without turning a persisted plan into a failed generation or hiding its original error.
export async function createPlanWithDiagnostics({ createPlan, planRequests, projectId, publishPlanEvent, logger = console }) {
  let request;
  let degraded = false;
  // Emits only a fixed code, phase and safe project/request identity; exception messages may contain credentials.
  const recordDiagnosticError = (phase) => {
    degraded = true;
    logger.error("Plan request diagnostics unavailable", { code: "PLAN_DIAGNOSTICS_UNAVAILABLE", phase, project_id: projectId, request_id: request?.request_id ?? null });
  };
  try { request = await planRequests?.start(); }
  catch (error) { recordDiagnosticError("start"); void error; }
  const requestId = request?.request_id ?? `PLAN-REQUEST-${randomUUID()}`;
  // Publishes a correlated progress signal independently of diagnostics and never authorizes approval from it.
  const publish = async (status, payload = {}) => {
    try { await publishPlanEvent?.({ project_id: projectId, event_type: `plan.request.${status}`, payload: { request_id: requestId, ...payload } }); }
    catch (error) { recordDiagnosticError("publication"); void error; }
  };
  await publish("generating");
  let result;
  try { result = await createPlan(); }
  catch (error) {
    if (request) {
      try { await planRequests.fail(request, error); }
      catch (diagnosticError) { recordDiagnosticError("fail"); void diagnosticError; }
    }
    await publish("failed", { error_code: /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? "") ? error.code : "PLAN_GENERATION_FAILED" });
    throw error;
  }
  if (request) {
    try { if (result.status === "awaiting_owner_decisions") await planRequests.wait?.(request, result); else await planRequests.complete(request, result); }
    catch (error) { recordDiagnosticError("complete"); void error; }
  }
  if (result.status === "awaiting_owner_decisions") await publish("awaiting_owner_decisions", { session_id: result.session_id });
  else await publish("persisted", { plan_id: result.plan_id, revision: result.revision, sha256: result.sha256 });
  return degraded ? { ...result, diagnostics_status: "degraded", diagnostics_error_code: "PLAN_DIAGNOSTICS_UNAVAILABLE" } : result;
}

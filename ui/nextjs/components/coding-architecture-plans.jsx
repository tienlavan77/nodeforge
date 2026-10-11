// Presents exact Architecture approvals above Coding sprints without depending on conversation or dashboard readiness.
"use client";
import { useEffect, useMemo, useState } from "react";
import { PlanReviewModal } from "./plan-review-modal.jsx";
import { architecturePlanName, createCodingPlanLoader } from "../lib/coding-plan-loader.js";
import { applyCodingPlanLifecycle } from "../lib/coding-plan-events.js";

// Reconciles plan revisions on project stream reconnect, tab return and bounded fallback polling.
export function CodingArchitecturePlans({ client, projectId, planEvents, onHandoffCompleted }) {
  const [snapshot, setSnapshot] = useState({ status: "loading", plans: [], error: null });
  const [selectedId, setSelectedId] = useState("");
  const [lifecycle, setLifecycle] = useState({});
  const [review, setReview] = useState(null);
  const loader = useMemo(() => createCodingPlanLoader({ client, projectId, onState: setSnapshot }), [client, projectId]);
  useEffect(() => {
    let scheduled = null;
    setLifecycle({});
    setReview(null);
    setSelectedId("");
    setSnapshot({ status: "loading", plans: [], error: null });
    // Coalesces stream bursts without interpreting their payload as approval authority.
    const invalidate = () => { if (!scheduled) scheduled = setTimeout(() => { scheduled = null; void loader.load(); }, 100); };
    const unsubscribe = planEvents?.subscribe((event) => {
      if (event.project_id !== projectId) return;
      if (event.event_type?.startsWith("plan.request.")) setLifecycle((current) => applyCodingPlanLifecycle(current, event, projectId));
      if (/^(?:plan\.|sprint\.|stream\.)/.test(event.event_type ?? "")) invalidate();
    });
    // Repairs missed delivery when the owner returns to Coding.
    const onVisible = () => { if (document.visibilityState === "visible") invalidate(); };
    document.addEventListener("visibilitychange", onVisible);
    void loader.load();
    return () => { unsubscribe?.(); clearTimeout(scheduled); document.removeEventListener("visibilitychange", onVisible); loader.cancel(); };
  }, [planEvents, projectId, loader]);
  const selected = snapshot.plans.find((plan) => plan.plan_id === selectedId) ?? snapshot.plans[0];
  const stale = review && !snapshot.plans.some((plan) => plan.plan_id === review.plan_id && plan.revision === review.revision && plan.sha256 === review.sha256);
  return <section className="coding-architecture-plans" aria-label="Architecture plan approval">
    <h2>Architecture plan</h2>
    {snapshot.status === "loading" && <p role="status">Loading plans…</p>}
    {Object.values(lifecycle).slice(-5).map((request) => <p key={`live:${request.request_id}`} role="status">Plan request {request.request_id}: {request.observed_generating && request.status !== "generating" ? "generating → " : ""}{request.status}. {request.status === "persisted" ? "Artifact persisted; refreshing authoritative approval state." : request.error_code ?? ""}</p>)}
    {(snapshot.requests ?? []).filter((request) => request.status !== "persisted" && !lifecycle[request.request_id]).map((request) => <p key={request.request_id} role={request.status === "generating" ? "status" : "alert"}>{request.status === "generating" ? "Architecture is generating a plan. Approval becomes available only after persistence." : `Plan request ${request.request_id}: ${request.status} · ${request.error_code}`}</p>)}
    {snapshot.diagnostics_error_code && <p role="alert">Planning diagnostics unavailable: {snapshot.diagnostics_error_code}. Persisted plans remain reviewable.</p>}
    {snapshot.error && <p role="alert">Plans could not be refreshed: {snapshot.error} <button type="button" onClick={() => loader.load()}>Retry</button></p>}
    {snapshot.status === "ready" && !selected && <p>No Architecture plan is awaiting approval or handoff.</p>}
    {snapshot.plans.length > 1 && <label>Plans requiring action ({snapshot.plans.length})<select value={selected?.plan_id ?? ""} onChange={(event) => setSelectedId(event.target.value)}>{snapshot.plans.map((plan) => <option key={plan.plan_id} value={plan.plan_id}>{plan.status === "approved" ? "Continue handoff · " : "Review · "}{architecturePlanName(plan)}</option>)}</select></label>}
    {selected && <div className="coding-architecture-plan-card"><strong>{architecturePlanName(selected)}</strong><p>Revision {selected.revision} · {selected.status}{selected.handoff_status ? ` · ${selected.handoff_status}` : ""}. Approval does not start RUN.</p>{selected.handoff_error_code && <p role="alert">Approved; handoff needs attention: {selected.handoff_error_code}</p>}<button type="button" disabled={snapshot.status !== "ready"} onClick={() => setReview(selected)}>{selected.status === "approved" ? "Continue handoff" : "Approve"}</button></div>}
    {stale && <p role="alert">The reviewed plan changed or completed. Close this review and reload before acting.</p>}
    {review && <PlanReviewModal key={`${projectId}:${review.plan_id}:${review.revision}:${review.sha256}`} client={client} projectId={projectId} planId={review.plan_id} initialPlan={review} onClose={() => setReview(null)} onChanged={async ({ handoff } = {}) => { setReview(null); await loader.load(); if (handoff?.sprint_id) await onHandoffCompleted?.(); }} />}
  </section>;
}

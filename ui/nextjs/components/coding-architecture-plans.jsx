// Presents exact Architecture approvals above Coding sprints without depending on conversation or dashboard readiness.
"use client";
import { useEffect, useMemo, useState } from "react";
import { PlanReviewModal } from "./plan-review-modal.jsx";
import { architecturePlanName, createCodingPlanLoader } from "../lib/coding-plan-loader.js";
import { applyCodingPlanLifecycle } from "../lib/coding-plan-events.js";
import { codingArchitecturePlanList, codingPlanArchiveKey, codingPlanArchiveStorageKey, readCodingPlanArchives, setCodingPlanArchived } from "../lib/coding-plan-archive.js";

// Reconciles plan revisions on project stream reconnect, tab return and bounded fallback polling.
export function CodingArchitecturePlans({ client, projectId, planEvents, onHandoffCompleted }) {
  const [snapshot, setSnapshot] = useState({ status: "loading", plans: [], error: null });
  const [archives, setArchives] = useState({ projectId: null, keys: [] });
  const [showArchived, setShowArchived] = useState(false);
  const [archiveError, setArchiveError] = useState("");
  const [lifecycle, setLifecycle] = useState({});
  const [review, setReview] = useState(null);
  const loader = useMemo(() => createCodingPlanLoader({ client, projectId, onState: setSnapshot }), [client, projectId]);
  useEffect(() => {
    setShowArchived(false);
    setArchives({ projectId, keys: [] });
    // Reconciles project-scoped archive preferences after reload or changes in another browser tab.
    function loadArchives() {
      try { setArchives({ projectId, keys: readCodingPlanArchives(projectId) }); setArchiveError(""); }
      catch (error) { console.error("Coding plan archive preferences could not be loaded.", error); setArchives({ projectId, keys: [] }); setArchiveError("Browser archive preferences could not be loaded. Plans remain visible."); }
    }
    // Ignores storage updates from other projects without changing the authoritative plan snapshot.
    function onStorage(event) { if (event.key === null || event.key === codingPlanArchiveStorageKey(projectId)) loadArchives(); }
    loadArchives();
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [projectId]);
  useEffect(() => {
    let scheduled = null;
    setLifecycle({});
    setReview(null);
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
  const archiveKeys = archives.projectId === projectId ? archives.keys : [];
  const visiblePlans = codingArchitecturePlanList(snapshot.plans, archiveKeys, showArchived);
  const archivedCount = snapshot.plans.filter((plan) => archiveKeys.includes(codingPlanArchiveKey(plan))).length;
  // Archives or restores a browser-local plan revision without changing approval or handoff authority.
  function handleArchive(plan, archived) {
    try {
      const keys = setCodingPlanArchived(projectId, plan, archived);
      setArchives({ projectId, keys });
      setArchiveError("");
      if (archived && review && codingPlanArchiveKey(review) === codingPlanArchiveKey(plan)) setReview(null);
    } catch (error) {
      console.error("Coding plan archive preferences could not be saved.", error);
      setArchiveError("Browser archive preferences could not be saved. The plan remains unchanged.");
    }
  }
  const stale = review && !snapshot.plans.some((plan) => plan.plan_id === review.plan_id && plan.revision === review.revision && plan.sha256 === review.sha256);
  return <section className="coding-architecture-plans" aria-label="Architecture plan approval">
    <h2>Architecture plan</h2>
    {snapshot.status === "loading" && <p role="status">Loading plans…</p>}
    {Object.values(lifecycle).slice(-5).map((request) => <p key={`live:${request.request_id}`} role="status">Plan request {request.request_id}: {request.observed_generating && request.status !== "generating" ? "generating → " : ""}{request.status}. {request.status === "persisted" ? "Artifact persisted; refreshing authoritative approval state." : request.error_code ?? ""}</p>)}
    {(snapshot.requests ?? []).filter((request) => request.status !== "persisted" && !lifecycle[request.request_id]).map((request) => <p key={request.request_id} role={request.status === "generating" ? "status" : "alert"}>{request.status === "generating" ? "Architecture is generating a plan. Approval becomes available only after persistence." : `Plan request ${request.request_id}: ${request.status} · ${request.error_code}`}</p>)}
    {snapshot.diagnostics_error_code && <p role="alert">Planning diagnostics unavailable: {snapshot.diagnostics_error_code}. Persisted plans remain reviewable.</p>}
    {snapshot.error && <p role="alert">Plans could not be refreshed: {snapshot.error} <button type="button" onClick={() => loader.load()}>Retry</button></p>}
    <p>Archive hides this revision in this browser only; it does not change approval or handoff.</p>
    {archiveError && <p role="alert">{archiveError}</p>}
    {archivedCount > 0 && <button type="button" aria-pressed={showArchived} onClick={() => setShowArchived((current) => !current)}>{showArchived ? "Hide archived" : "Show archived"} ({archivedCount})</button>}
    {snapshot.status === "ready" && visiblePlans.length === 0 && <p>{archivedCount > 0 ? "All current Architecture plans are archived in this browser. Show archived to restore them." : "No Architecture plan is awaiting approval or handoff."}</p>}
    <ul className="coding-architecture-plan-list">{visiblePlans.map((plan) => {
      const archived = archiveKeys.includes(codingPlanArchiveKey(plan));
      return <li key={codingPlanArchiveKey(plan)} className={`coding-architecture-plan-card${archived ? " is-archived" : ""}`}>
        <strong>{architecturePlanName(plan)}</strong>
        <p>Revision {plan.revision} · {plan.status}{plan.handoff_status ? ` · ${plan.handoff_status}` : ""}. Approval does not start RUN.{archived ? " Archived in this browser." : ""}</p>
        {plan.handoff_error_code && <p role="alert">Approved; handoff needs attention: {plan.handoff_error_code}</p>}
        <div className="coding-architecture-plan-actions">
          {!archived && <button type="button" disabled={snapshot.status !== "ready"} onClick={() => setReview(plan)}>{plan.status === "approved" ? "Continue handoff" : "Approve"}</button>}
          <button type="button" disabled={snapshot.status !== "ready"} onClick={() => handleArchive(plan, !archived)}>{archived ? "Restore" : "Archive"}</button>
        </div>
      </li>;
    })}</ul>
    {stale && <p role="alert">The reviewed plan changed or completed. Close this review and reload before acting.</p>}
    {review && <PlanReviewModal key={`${projectId}:${review.plan_id}:${review.revision}:${review.sha256}`} client={client} projectId={projectId} planId={review.plan_id} initialPlan={review} onClose={() => setReview(null)} onChanged={async ({ handoff } = {}) => { setReview(null); await loader.load(); if (handoff?.sprint_id) await onHandoffCompleted?.(); }} />}
  </section>;
}

"use client";

import { useCallback, useEffect, useState } from "react";

// Business purpose: renders AM-SE-RV checkpoint evidence and owner-authorized recovery actions in the Architecture workspace.
// Technical description: polls the redacted handoff projection and delegates Resume or Reconcile to guarded backend methods without replaying steps in the browser.
export function AmSeHandoffControls({ client, projectId, refreshSignal = 0, embedded = false }) {
  const [handoffs, setHandoffs] = useState([]);
  const [ownerToken, setOwnerToken] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [workspaceStatus, setWorkspaceStatus] = useState({});
  const [plans, setPlans] = useState([]);
  const [planTitles, setPlanTitles] = useState({});
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [result, listedPlans] = await Promise.all([client.listHandoffs(projectId), Promise.resolve().then(() => client.listPlans?.(projectId) ?? [])]);
      const currentHandoffs = result?.items ?? [];
      setHandoffs(currentHandoffs);
      const currentPlans = listedPlans ?? [];
      setPlans(currentPlans);
      const listedTitles = Object.fromEntries(currentPlans.map((plan) => [plan.plan_id, plan.title ?? plan.name ?? `Plan ${plan.plan_id}`]));
      if (client.getPlanRevision) {
        const revisions = await Promise.all(currentHandoffs.map(async (handoff) => {
          try { return await client.getPlanRevision(projectId, handoff.plan_id, handoff.plan_revision); }
          catch { return null; }
        }));
        revisions.filter(Boolean).forEach((plan) => { listedTitles[plan.plan_id] = plan.content?.title ?? plan.content?.name ?? listedTitles[plan.plan_id]; });
      }
      setPlanTitles(listedTitles);
    } catch (reason) {
      setError(reason?.message ?? "Could not load AM-SE-RV handoff checkpoints.");
    }
  }, [client, projectId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh, refreshSignal]);

  // Business purpose: approves the exact SE-targeted plan from the handoff monitor before checkpoint execution begins.
  // Technical description: records an exact owner decision through the plan API, then resumes the SE checkpoint instead of invoking the SL /approve command.
  async function approve(handoff) {
    if (!ownerToken) { setError("Owner token is required for plan approval."); return; }
    setBusyId(`${handoff.handoff_id}:approve`);
    setError("");
    try {
      const plan = await client.getPlanRevision(projectId, handoff.plan_id, handoff.plan_revision);
      if (plan.revision !== handoff.plan_revision || plan.sha256 !== handoff.plan_sha256 || plan.status === "superseded") throw new Error("Plan changed; refresh before approving this handoff.");
      if (plan.status === "awaiting_human_approval") await client.decidePlan(projectId, plan, "approved", ownerToken);
      else if (plan.status !== "approved") throw new Error("This plan cannot be approved for SE handoff.");
      await client.resumeHandoff(projectId, handoff, ownerToken);
      await refresh();
    } catch (reason) { setError(reason?.message ?? "Could not approve the plan."); }
    finally { setBusyId(""); }
  }

  // Business purpose: shows the exact workspace drift before asking the Owner to make a recovery decision.
  // Technical description: reads the backend's bounded snapshot comparison without mutating files or checkpoint state.
  async function inspectWorkspace(handoff) {
    setBusyId(`${handoff.handoff_id}:inspect`);
    try {
      const status = await client.getHandoffWorkspace(projectId, handoff);
      setWorkspaceStatus((current) => ({ ...current, [handoff.handoff_id]: status }));
    } catch (reason) { setError(reason?.message ?? "Could not inspect workspace."); }
    finally { setBusyId(""); }
  }

  // Business purpose: deletes the selected plan only after an explicit confirmation from the Owner.
  // Technical description: sends the current revision as an optimistic-concurrency token, then refreshes the handoff and plan projections without mutating files in the browser.
  async function deletePlan() {
    if (!deleteTarget) return;
    setBusyId(`${deleteTarget.plan_id}:delete`);
    setError("");
    try {
      await client.deletePlan(projectId, deleteTarget);
      setDeleteTarget(null);
      await refresh();
    } catch (reason) { setError(reason?.message ?? "Could not delete the plan."); }
    finally { setBusyId(""); }
  }

  // Business purpose: invokes one owner-authorized handoff recovery action and refreshes the durable projection.
  // Technical description: sends no agent work from the browser; the backend validates approval, receipts and checkpoint generation.
  async function recover(handoff, action) {
    if (["critique-resume", "pause", "reconcile"].includes(action) && !ownerToken) { setError("Owner token is required for this action."); return; }
    if (action === "critique-resume") {
      setBusyId(`${handoff.handoff_id}:${action}`);
      setError("");
      try { await client.resumeCritique(projectId, handoff, ownerToken); await refresh(); }
      catch (reason) { setError(reason?.message ?? `Could not ${action} handoff.`); }
      finally { setBusyId(""); }
      return;
    }
    if (action === "reconcile") {
      setBusyId(`${handoff.handoff_id}:${action}`);
      setError("");
      try {
        const result = await client.reconcileHandoff(projectId, handoff, ownerToken, true);
        if (result?.classification === "blocked") throw new Error("Reconciliation is blocked; inspect the execution evidence before retrying.");
        await refresh();
      } catch (reason) { setError(reason?.message ?? "Could not reconcile the handoff."); }
      finally { setBusyId(""); }
      return;
    }
    if (action === "pause") {
      setBusyId(`${handoff.handoff_id}:${action}`);
      setError("");
      try { await client.pauseHandoff(projectId, handoff, ownerToken); await refresh(); }
      catch (reason) { setError(reason?.message ?? `Could not ${action} handoff.`); }
      finally { setBusyId(""); }
      return;
    }
    if (!ownerToken) { setError("Owner token is required for handoff recovery."); return; }
    setBusyId(`${handoff.handoff_id}:${action}`);
    setError("");
    try {
      if (action === "resume") await client.resumeHandoff(projectId, handoff, ownerToken);
      else if (action === "adopt") {
        if (!window.confirm("Accept the CURRENT workspace as this handoff's baseline? This does not restore or delete files. Only a stopped, tool-free first SE attempt is eligible.")) return;
        await client.adoptHandoffWorkspace(projectId, handoff, ownerToken);
        setWorkspaceStatus((current) => ({ ...current, [handoff.handoff_id]: null }));
      } else throw new Error(`Unsupported handoff action: ${action}`);
      await refresh();
    } catch (reason) {
      setError(reason?.message ?? `Could not ${action} handoff.`);
      if (reason?.code === "HANDOFF_WORKSPACE_MISMATCH") {
        try {
          const status = await client.getHandoffWorkspace(projectId, handoff);
          setWorkspaceStatus((current) => ({ ...current, [handoff.handoff_id]: status }));
        } catch { /* Preserve the resume error; manual inspection remains available. */ }
      }
    } finally {
      setBusyId("");
    }
  }

  const content = <section className="am-se-handoff-controls" aria-label="AM SE RV handoff checkpoints">
    <div className="am-se-handoff-header"><div><h2>AM ↔ SE ↔ RV handoff</h2><p>Durable checkpoint state and evidence-backed recovery.</p></div><input type="password" aria-label="Owner token for handoff recovery" placeholder="Owner token" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} /></div>
    {error && <p role="alert">{error}</p>}
    {!handoffs.length && <p>No persisted handoff checkpoints.</p>}
    {handoffs.map((handoff) => {
      const checkpoint = handoff.checkpoint;
      const results = checkpoint?.results ?? [];
      const recoveryAllowed = handoff.critique_can_resume === true || handoff.can_resume === true || handoff.can_reconcile === true || handoff.can_pause === true;
      return <article className="am-se-handoff-card" key={handoff.handoff_id}>
        <header className="am-se-handoff-card-heading"><div><strong className="am-se-handoff-plan-id">{handoff.plan_id} · r{handoff.plan_revision}</strong><h3 className="am-se-handoff-plan-title">{planTitles[handoff.plan_id] ?? `Plan ${handoff.plan_id}`}</h3></div><span>{handoff.status} · {handoff.phase}</span></header>
        <p className="am-se-handoff-identity">{handoff.handoff_id} · SHA {handoff.plan_sha256}</p>
        {handoff.critique_checkpoint && <p className="am-se-handoff-checkpoint">critique: {handoff.critique_checkpoint.current_step ?? "idle"} → {handoff.critique_checkpoint.next_step ?? "done"} · attempt {handoff.critique_checkpoint.attempt ?? 0}{handoff.critique_checkpoint.error_code && ` · ${handoff.critique_checkpoint.error_code}`}</p>}
        {checkpoint && <div className="am-se-handoff-checkpoint"><span>step: {checkpoint.current_step ?? "none"}</span><span>next: {checkpoint.next_step ?? "none"}</span><span>execution: {checkpoint.execution_status}</span><span>attempt: {checkpoint.attempt ?? 0}</span>{checkpoint.error_code && <span>error: {checkpoint.error_code}</span>}</div>}
        {checkpoint && <button type="button" disabled={Boolean(busyId)} onClick={() => void inspectWorkspace(handoff)}>Inspect workspace baseline</button>}
        {workspaceStatus[handoff.handoff_id]?.adoption_blocked && <p role="status">Cannot accept this baseline: {workspaceStatus[handoff.handoff_id].adoption_blocked === "baseline_already_adopted" ? "this checkpoint has already adopted a baseline once." : "the previous SE attempt lacks a verified stopped, tool-free receipt."} Do not reset your files; reconcile this attempt separately.</p>}
        {workspaceStatus[handoff.handoff_id] && <div className="am-se-handoff-checkpoint" role="status">{workspaceStatus[handoff.handoff_id].matches ? "Workspace matches checkpoint baseline." : <>Workspace differs: {workspaceStatus[handoff.handoff_id].reason}. Baseline HEAD {workspaceStatus[handoff.handoff_id].baseline_head}; current HEAD {workspaceStatus[handoff.handoff_id].current_head}. {(workspaceStatus[handoff.handoff_id].paths ?? []).length ? `Changed paths: ${workspaceStatus[handoff.handoff_id].paths.join(", ")}.` : workspaceStatus[handoff.handoff_id].reason === "legacy_baseline" ? "Older checkpoints store only a fingerprint; the original file contents cannot be recovered from it." : "The change is in Git HEAD, staging, or workspace metadata; inspect Git status before restoring anything."} Restore changes manually if known, or ask the approving Owner to adopt the current workspace where safe. Never run git reset --hard unless you have backed up all changes.</>}</div>}
        <ol className="am-se-handoff-results">{results.map((result) => <li key={`${result.execution_id}:${result.attempt}`}><strong>{result.step?.toUpperCase()} R{result.round}</strong><span>{result.verdict ?? "completed"}</span><small>{result.text ?? "No text evidence"}</small>{result.result_evidence && <small>SDK: {result.result_evidence.sdk_status ?? "unknown"} · receipt: {result.execution_id}</small>}</li>)}</ol>
        <div className="am-se-handoff-actions" aria-label="Handoff controls">
          <button type="button" disabled={Boolean(busyId) || handoff.approval_required !== true} onClick={() => void approve(handoff)} title={handoff.approval_required ? "Approve this plan and start the handoff." : "Run is available after Owner approval."}>{busyId === `${handoff.handoff_id}:approve` ? "Running…" : "Run"}</button>
          <button type="button" disabled={Boolean(busyId) || handoff.can_resume !== true} onClick={() => void recover(handoff, "resume")} title={handoff.can_resume ? "Resume from the saved checkpoint." : "No resumable checkpoint is available."}>{busyId === `${handoff.handoff_id}:resume` ? "Resuming…" : "Resume"}</button>
          <button type="button" disabled={Boolean(busyId) || handoff.can_pause !== true} onClick={() => void recover(handoff, "pause")} title={handoff.can_pause ? "Stop the running handoff and save its state." : "The handoff is not currently running."}>{busyId === `${handoff.handoff_id}:pause` ? "Stopping…" : "Stop"}</button>
          {handoff.critique_can_resume && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "critique-resume")}>{busyId === `${handoff.handoff_id}:critique-resume` ? "Resuming…" : "Resume critique"}</button>}
          {handoff.can_reconcile && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "reconcile")} title="Verify the stopped execution before allowing Resume.">{busyId === `${handoff.handoff_id}:reconcile` ? "Checking…" : "Reconcile"}</button>}
          {handoff.can_reconcile && !handoff.can_resume && <span>Execution requires reconciliation; Resume cannot retry it yet.</span>}
          {handoff.can_resume && workspaceStatus[handoff.handoff_id]?.matches === false && workspaceStatus[handoff.handoff_id]?.can_adopt === true && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "adopt")}>Accept current workspace baseline</button>}
          <button type="button" className="am-se-handoff-delete" disabled={Boolean(busyId)} onClick={() => setDeleteTarget(plans.find((plan) => plan.plan_id === handoff.plan_id && plan.revision === handoff.plan_revision) ?? { plan_id: handoff.plan_id, revision: handoff.plan_revision })}>Delete plan</button>
        </div>
      </article>;
    })}
  </section>;

  const deleteDialog = deleteTarget && <div className="am-se-handoff-modal-backdrop" role="presentation"><div className="am-se-handoff-modal" role="dialog" aria-modal="true" aria-labelledby="delete-plan-title"><h2 id="delete-plan-title">Delete plan?</h2><p>This permanently deletes <strong>{planTitles[deleteTarget.plan_id] ?? `Plan ${deleteTarget.plan_id}`}</strong> and its revisions. This action cannot be undone.</p><div className="am-se-handoff-modal-actions"><button type="button" onClick={() => setDeleteTarget(null)} disabled={Boolean(busyId)}>Cancel</button><button type="button" className="am-se-handoff-delete" onClick={() => void deletePlan()} disabled={Boolean(busyId)}>{busyId === `${deleteTarget.plan_id}:delete` ? "Deleting…" : "Delete"}</button></div></div></div>;

  if (embedded) return <>{content}{deleteDialog}</>;
  return <>{deleteDialog}<button className="am-se-handoff-launcher" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Close handoff" : "Handoff"}</button>{open && content}</>;
}

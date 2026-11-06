"use client";

import { useCallback, useEffect, useState } from "react";

// Business purpose: renders AM-SE-RV checkpoint evidence and owner-authorized recovery actions in the Architecture workspace.
// Technical description: polls the redacted handoff projection and delegates Resume or Reconcile to guarded backend methods without replaying steps in the browser.
export function AmSeHandoffControls({ client, projectId, refreshSignal = 0, embedded = false }) {
  const [handoffs, setHandoffs] = useState([]);
  const [ownerToken, setOwnerToken] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await client.listHandoffs(projectId);
      setHandoffs(result?.items ?? []);
      setError("");
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

  // Business purpose: invokes one owner-authorized handoff recovery action and refreshes the durable projection.
  // Technical description: sends no agent work from the browser; the backend validates approval, receipts and checkpoint generation.
  async function recover(handoff, action) {
    if (action === "critique-resume") {
      setBusyId(`${handoff.handoff_id}:${action}`);
      setError("");
      try { await client.resumeCritique(projectId, handoff); await refresh(); }
      catch (reason) { setError(reason?.message ?? `Could not ${action} handoff.`); }
      finally { setBusyId(""); }
      return;
    }
    if (action === "pause") {
      setBusyId(`${handoff.handoff_id}:${action}`);
      setError("");
      try { await client.pauseHandoff(projectId, handoff); await refresh(); }
      catch (reason) { setError(reason?.message ?? `Could not ${action} handoff.`); }
      finally { setBusyId(""); }
      return;
    }
    if (!ownerToken) { setError("Owner token is required for handoff recovery."); return; }
    setBusyId(`${handoff.handoff_id}:${action}`);
    setError("");
    try {
      if (action === "resume") await client.resumeHandoff(projectId, handoff, ownerToken);
      else throw new Error(`Unsupported handoff action: ${action}`);
      await refresh();
    } catch (reason) {
      setError(reason?.message ?? `Could not ${action} handoff.`);
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
        <header><strong>{handoff.plan_id} r{handoff.plan_revision}</strong><span>{handoff.status} · {handoff.phase}</span></header>
        <p className="am-se-handoff-identity">{handoff.handoff_id} · SHA {handoff.plan_sha256}</p>
        {handoff.critique_checkpoint && <p className="am-se-handoff-checkpoint">critique: {handoff.critique_checkpoint.current_step ?? "idle"} → {handoff.critique_checkpoint.next_step ?? "done"} · attempt {handoff.critique_checkpoint.attempt ?? 0}{handoff.critique_checkpoint.error_code && ` · ${handoff.critique_checkpoint.error_code}`}</p>}
        <div className="am-se-handoff-roles">{Object.entries(handoff.roles ?? {}).map(([role, identity]) => <div key={role} className="am-se-handoff-role"><strong>{role.toUpperCase()}</strong><span>{identity.agent_id ?? "unassigned"}</span><span>{identity.conversation_id ?? "no conversation"}</span></div>)}</div>
        {checkpoint && <div className="am-se-handoff-checkpoint"><span>step: {checkpoint.current_step ?? "none"}</span><span>next: {checkpoint.next_step ?? "none"}</span><span>execution: {checkpoint.execution_status}</span><span>attempt: {checkpoint.attempt ?? 0}</span>{checkpoint.error_code && <span>error: {checkpoint.error_code}</span>}</div>}
        <ol className="am-se-handoff-results">{results.map((result) => <li key={`${result.execution_id}:${result.attempt}`}><strong>{result.step?.toUpperCase()} R{result.round}</strong><span>{result.verdict ?? "completed"}</span><small>{result.text ?? "No text evidence"}</small>{result.result_evidence && <small>SDK: {result.result_evidence.sdk_status ?? "unknown"} · receipt: {result.execution_id}</small>}</li>)}</ol>
        {handoff.approval_required && <div className="am-se-handoff-actions"><button type="button" disabled={Boolean(busyId)} onClick={() => void approve(handoff)}>{busyId === `${handoff.handoff_id}:approve` ? "Approving…" : "Approve plan"}</button></div>}
        {recoveryAllowed && <div className="am-se-handoff-actions">{handoff.critique_can_resume && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "critique-resume")}>{busyId === `${handoff.handoff_id}:critique-resume` ? "Resuming…" : "Resume critique"}</button>}{(handoff.can_resume || handoff.can_reconcile) && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "resume")}>{busyId === `${handoff.handoff_id}:resume` ? "Resuming…" : "Resume checkpoint"}</button>}{handoff.can_pause && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "pause")}>{busyId === `${handoff.handoff_id}:pause` ? "Pausing…" : "Pause"}</button>}</div>}
      </article>;
    })}
  </section>;

  if (embedded) return content;
  return <><button className="am-se-handoff-launcher" type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? "Close handoff" : "Handoff"}</button>{open && content}</>;
}

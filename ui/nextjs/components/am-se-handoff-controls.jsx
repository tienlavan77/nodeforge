// Business purpose: gives the Project Owner a durable view of AM-SE-RV handoff progress and guarded recovery actions.
// Technical description: polls the backend handoff projection, renders per-role checkpoint evidence, and delegates Resume or Reconcile to backend authorization and generation guards.
"use client";

import { useCallback, useEffect, useState } from "react";

// Business purpose: renders AM-SE-RV checkpoint evidence and owner-authorized recovery actions in the Architecture workspace.
// Technical description: polls the redacted handoff projection and delegates Resume or Reconcile to guarded backend methods without replaying steps in the browser.
export function AmSeHandoffControls({ client, projectId, refreshSignal = 0 }) {
  const [handoffs, setHandoffs] = useState([]);
  const [ownerToken, setOwnerToken] = useState("");
  const [busyId, setBusyId] = useState("");
  const [error, setError] = useState("");

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

  // Business purpose: invokes one owner-authorized handoff recovery action and refreshes the durable projection.
  // Technical description: sends no agent work from the browser; the backend validates approval, receipts and checkpoint generation.
  async function recover(handoff, action) {
    if (!ownerToken) { setError("Owner token is required for handoff recovery."); return; }
    setBusyId(`${handoff.handoff_id}:${action}`);
    setError("");
    try {
      if (action === "resume") await client.resumeHandoff(projectId, handoff, ownerToken);
      else await client.reconcileHandoff(projectId, handoff, ownerToken, true);
      await refresh();
    } catch (reason) {
      setError(reason?.message ?? `Could not ${action} handoff.`);
    } finally {
      setBusyId("");
    }
  }

  return <section className="am-se-handoff-controls" aria-label="AM SE RV handoff checkpoints">
    <div className="am-se-handoff-header">
      <div><h2>AM ↔ SE ↔ RV handoff</h2><p>Durable checkpoint state and evidence-backed recovery.</p></div>
      <input type="password" aria-label="Owner token for handoff recovery" placeholder="Owner token" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} />
    </div>
    {error && <p role="alert">{error}</p>}
    {!handoffs.length && <p>No persisted handoff checkpoints.</p>}
    {handoffs.map((handoff) => {
      const checkpoint = handoff.checkpoint;
      const results = checkpoint?.results ?? [];
      const recoveryAllowed = handoff.can_resume === true || handoff.can_reconcile === true;
      return <article className="am-se-handoff-card" key={handoff.handoff_id}>
        <header><strong>{handoff.plan_id} r{handoff.plan_revision}</strong><span>{handoff.status} · {handoff.phase}</span></header>
        <p className="am-se-handoff-identity">{handoff.handoff_id} · SHA {handoff.plan_sha256}</p>
        <div className="am-se-handoff-roles">
          {Object.entries(handoff.roles ?? {}).map(([role, identity]) => <div key={role} className="am-se-handoff-role"><strong>{role.toUpperCase()}</strong><span>{identity.agent_id ?? "unassigned"}</span><span>{identity.conversation_id ?? "no conversation"}</span></div>)}
        </div>
        {checkpoint && <div className="am-se-handoff-checkpoint"><span>step: {checkpoint.current_step ?? "none"}</span><span>next: {checkpoint.next_step ?? "none"}</span><span>execution: {checkpoint.execution_status}</span><span>attempt: {checkpoint.attempt ?? 0}</span>{checkpoint.error_code && <span>error: {checkpoint.error_code}</span>}</div>}
        <ol className="am-se-handoff-results">{results.map((result) => <li key={`${result.execution_id}:${result.attempt}`}><strong>{result.step?.toUpperCase()} R{result.round}</strong><span>{result.verdict ?? "completed"}</span><small>{result.text ?? "No text evidence"}</small>{result.result_evidence && <small>SDK: {result.result_evidence.sdk_status ?? "unknown"} · receipt: {result.execution_id}</small>}</li>)}</ol>
        {recoveryAllowed && <div className="am-se-handoff-actions">{handoff.can_resume && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "resume")}>{busyId === `${handoff.handoff_id}:resume` ? "Resuming…" : "Resume checkpoint"}</button>}{handoff.can_reconcile && <button type="button" disabled={Boolean(busyId)} onClick={() => void recover(handoff, "reconcile")}>{busyId === `${handoff.handoff_id}:reconcile` ? "Reconciling…" : "Reconcile evidence"}</button>}</div>}
      </article>;
    })}
  </section>;
}

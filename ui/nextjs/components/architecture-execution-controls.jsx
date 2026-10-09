// Gives Architecture conversation owners immediate pause and recovery controls.
"use client";

import { useEffect, useRef, useState } from "react";
import { awaitingOwnerExecutionRecovery, watchOwnerExecutionRecovery } from "../lib/owner-execution-recovery.js";

// Shows durable Architecture attempts and stops only the active conversation after owner action.
export function ArchitectureExecutionControls({ client, projectId, conversationId, executionId, agentTyping }) {
  const [executions, setExecutions] = useState([]);
  const [error, setError] = useState("");
  const [, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const [ownerToken, setOwnerToken] = useState("");
  const lastEscape = useRef(0);
  const inFlight = useRef(false);
  const current = executions.find((entry) => entry.conversation_id === conversationId && entry.status === "running")
    ?? executions.find((entry) => entry.conversation_id === conversationId && entry.status === "pausing")
    ?? executions.find((entry) => entry.conversation_id === conversationId && ["manual_required", "interrupted"].includes(entry.status));

  useEffect(() => {
    setExecutions([]);
    setHint("");
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return undefined;
    let mounted = true;
    // Refreshes the selected Architecture attempt after reload or a provider interruption.
    async function refresh() {
      try {
        const result = await client.listOwnerExecutions(projectId, conversationId);
        if (mounted) {
          setExecutions((previous) => (result.items ?? []).map((entry) => previous.some((item) => item.execution_id === entry.execution_id && item.status === "pausing") && entry.status === "running" ? { ...entry, status: "pausing" } : entry));
          setError("");
        }
      } catch (reason) { if (mounted) setError(reason.message ?? "Unable to load Architecture executions."); }
    }
    void refresh();
    return () => { mounted = false; };
  }, [client, projectId, conversationId]);

  const awaitingStop = awaitingOwnerExecutionRecovery(current);
  useEffect(() => {
    if (!conversationId || !awaitingStop) return undefined;
    return watchOwnerExecutionRecovery({ client, projectId, conversationId, executionId: current?.execution_id,
      onUpdate: (items) => { setExecutions(items); setError(""); }, onError: setError });
  }, [client, projectId, conversationId, current?.execution_id, awaitingStop]);

  // Sends pause and recovery actions for the selected Architecture execution.
  async function decide(action) {
    if (inFlight.current || !conversationId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const record = action === "pause" && executionId && agentTyping ? { conversation_id: conversationId, execution_id: executionId, status: "running" } : current;
      if (!record || (action === "pause" && record.status !== "running")) throw new Error("No active Architecture execution to pause yet.");
      if (action === "reconcile") { await client.reconcileOwnerExecution(projectId, conversationId, record.execution_id, undefined, ownerToken); setOwnerToken(""); }
      else await client.decideOwnerExecution(projectId, conversationId, record.execution_id, action);
      setExecutions((items) => {
        const status = action === "pause" ? "pausing" : action === "reconcile" ? "interrupted" : action === "continue" ? "running" : action === "restart" ? "restarted" : "discarded";
        return items.some((entry) => entry.execution_id === record.execution_id) ? items.map((entry) => entry.execution_id === record.execution_id ? { ...entry, status } : entry) : [...items, { ...record, status }];
      });
    } catch (reason) { setError(reason.message ?? "Architecture recovery was blocked."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  useEffect(() => {
    if (current?.status !== "running" && (current || !agentTyping)) return undefined;
    // Ignores dialogs, renames, IME and held keys before counting Escape presses.
    function onKeyDown(event) {
      if (event.key !== "Escape" || event.repeat || event.isComposing || event.nativeEvent?.isComposing || event.target?.closest?.('[role="dialog"], [aria-modal="true"], .conversations-accordion-rename-input')) return;
      const now = Date.now();
      if (now - lastEscape.current > 3000) {
        lastEscape.current = now;
        return;
      }
      lastEscape.current = 0;
      setHint("");
      event.preventDefault();
      void decide("pause");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); lastEscape.current = 0; setHint(""); };
  }, [current?.execution_id, current?.status, agentTyping, conversationId, busy]);

  return <div className="claude-chat-status architecture-execution-controls" role="status" aria-live="polite">
    {current?.status === "pausing" && <span>Stopping current action…</span>}
    {["pausing", "interrupted"].includes(current?.status) && <>{current?.status === "interrupted" && <span>One action interrupted</span>}{["continue", "restart", "discard"].map((action) => <button key={action} type="button" className="claude-retry" disabled={busy || current?.status === "pausing" || !current?.[`can_${action}`]} onClick={() => void decide(action)} aria-label={action === "continue" ? "Continue interrupted action" : action === "restart" ? "Restart interrupted action" : "Discard interrupted action"}>{action === "continue" ? "Continue" : action === "restart" ? "Restart" : "Discard"}</button>)}</>}
    {current?.status === "manual_required" && <><span>Execution needs owner review.</span>{current.can_reconcile && <><input className="architecture-owner-token" type="password" aria-label="Owner token" autoComplete="off" value={ownerToken} onChange={(event) => setOwnerToken(event.target.value)} /><button type="button" className="claude-retry" disabled={busy || !ownerToken} onClick={() => void decide("reconcile")}>Verify document</button></>}{current.can_discard && <button type="button" className="claude-retry" disabled={busy} onClick={() => void decide("discard")}>Discard</button>}</>}
    {error && <span>{error}</span>}
  </div>;
}

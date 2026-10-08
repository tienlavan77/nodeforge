// Gives Architecture conversation owners immediate pause and recovery controls.
"use client";

import { useEffect, useRef, useState } from "react";

// Shows durable Architecture attempts and stops only the active conversation after owner action.
export function ArchitectureExecutionControls({ client, projectId, conversationId, executionId, agentTyping, onPause, refreshSignal }) {
  const [executions, setExecutions] = useState([]);
  const [error, setError] = useState("");
  const [, setHint] = useState("");
  const [busy, setBusy] = useState(false);
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
  }, [client, projectId, conversationId, refreshSignal]);

  // Sends pause and recovery actions for the selected Architecture execution.
  async function decide(action) {
    if (inFlight.current || !conversationId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const record = action === "pause" && executionId && agentTyping ? { conversation_id: conversationId, execution_id: executionId, status: "running" } : current;
      if (!record || (action === "pause" && record.status !== "running")) throw new Error("No active Architecture execution to pause yet.");
      if (action === "reconcile") await client.reconcileOwnerExecution(projectId, conversationId, record.execution_id);
      else await client.decideOwnerExecution(projectId, conversationId, record.execution_id, action);
      setExecutions((items) => {
        const status = action === "pause" || action === "reconcile" ? "interrupted" : action === "continue" ? "running" : action === "restart" ? "restarted" : "discarded";
        return items.some((entry) => entry.execution_id === record.execution_id) ? items.map((entry) => entry.execution_id === record.execution_id ? { ...entry, status } : entry) : [...items, { ...record, status }];
      });
      if (action === "pause") onPause?.(false);
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
    {current?.status === "interrupted" && <><span>One action interrupted</span>{["continue", "restart", "discard"].map((action) => <button key={action} type="button" className="claude-retry" disabled={busy} onClick={() => void decide(action)} aria-label={action === "continue" ? "Continue interrupted action" : action === "restart" ? "Restart interrupted action" : "Discard interrupted action"}>{action === "continue" ? "Continue" : action === "restart" ? "Restart" : "Discard"}</button>)}</>}
    {current?.status === "manual_required" && <><span>Document needs verification before recovery.</span>{current.can_reconcile && <button type="button" className="claude-retry" disabled={busy} onClick={() => void decide("reconcile")}>Verify document</button>}</>}
    {error && <span>{error}</span>}
  </div>;
}

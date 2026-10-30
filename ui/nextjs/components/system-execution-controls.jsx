// Lets owners pause and recover interrupted System Engineer work without blindly repeating Git changes.
"use client";

import { useEffect, useRef, useState } from "react";
import { awaitingOwnerExecutionRecovery, watchOwnerExecutionRecovery } from "../lib/owner-execution-recovery.js";

// Shows durable execution status and requires a second Escape key press to pause active work.
export function SystemExecutionControls({ client, projectId, conversationId, executionId, agentTyping, interruptionSignal = 0, onDecision }) {
  const [executions, setExecutions] = useState([]);
  const [, setHint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastEscape = useRef(0);
  const inFlight = useRef(false);
  const revision = useRef(0);
  const scopedExecutions = executions.filter((entry) => entry.conversation_id === conversationId);
  const current = scopedExecutions.find((entry) => entry.status === "running")
    ?? scopedExecutions.find((entry) => entry.status === "pausing")
    ?? scopedExecutions.find((entry) => ["interrupted", "manual_required"].includes(entry.status));
  const currentId = current?.execution_id;
  const currentStatus = current?.status;

  useEffect(() => {
    if (!conversationId) { setExecutions([]); return undefined; }
    let mounted = true;
    const requestRevision = revision.current;
    // Refreshes the owner's recovery options when a turn or Control API process changes.
    const refresh = async () => {
      try {
        const response = await client.listOwnerExecutions(projectId, conversationId);
        if (mounted && requestRevision === revision.current) {
          setExecutions((previous) => (response.items ?? []).map((entry) => previous.some((item) => item.execution_id === entry.execution_id && item.status === "pausing") && entry.status === "running" ? { ...entry, status: "pausing" } : entry));
          setError("");
        }
      } catch (reason) { if (mounted && requestRevision === revision.current) setError(reason.message ?? "Unable to load executions."); }
    };
    void refresh();
    return () => { mounted = false; };
  }, [client, projectId, conversationId, executionId, agentTyping, interruptionSignal]);

  const awaitingStop = awaitingOwnerExecutionRecovery(current);
  useEffect(() => {
    if (!conversationId || !awaitingStop || busy) return undefined;
    const requestRevision = revision.current;
    return watchOwnerExecutionRecovery({ client, projectId, conversationId, executionId: currentId,
      onUpdate: (items) => { if (requestRevision === revision.current) { setExecutions(items); setError(""); } },
      onError: (message) => { if (requestRevision === revision.current) setError(message); } });
  }, [client, projectId, conversationId, currentId, awaitingStop, busy]);

  useEffect(() => {
    if (currentStatus !== "running" && (current || !agentTyping)) return undefined;
    // Requires two Escape presses within three seconds to stop the current agent turn.
    const onKeyDown = (event) => {
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
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); lastEscape.current = 0; setHint(""); };
  }, [client, projectId, conversationId, currentId, currentStatus, agentTyping, busy]);

  // Sends one pause or recovery decision and keeps the visible state in sync.
  async function decide(action) {
    if (inFlight.current || !conversationId) return;
    inFlight.current = true;
    revision.current += 1;
    setBusy(true);
    setError("");
    try {
      const record = action === "pause" && executionId && agentTyping ? { conversation_id: conversationId, execution_id: executionId, status: "running" } : current;
      if (!record || (action === "pause" && record.status !== "running")) throw new Error("No active System Engineer execution to pause yet.");
      const result = await client.decideOwnerExecution(projectId, conversationId, record.execution_id, action);
      setExecutions((previous) => {
        const status = action === "pause" ? "pausing" : (result?.status ?? (action === "continue" || action === "restart" ? "running" : "discarded"));
        return previous.some((entry) => entry.execution_id === record.execution_id) ? previous.map((entry) => entry.execution_id === record.execution_id ? { ...entry, ...result, status } : entry) : [...previous, { ...record, ...result, status }];
      });
      onDecision?.({ action, executionId: record.execution_id, nextExecutionId: result?.execution_id });
    } catch (reason) {
      const message = reason.message ?? "Unable to update execution.";
      setError(message);
      const requestRevision = revision.current;
      try {
        const response = await client.listOwnerExecutions(projectId, conversationId);
        if (requestRevision === revision.current) setExecutions(response.items ?? []);
      } catch (refreshError) { setError(`${message} ${refreshError.message ?? "Unable to refresh execution status."}`); }
    }
    finally { inFlight.current = false; setBusy(false); }
  }

  if (!current && !agentTyping && !error) return null;
  return <div className="claude-chat-status" role="status" aria-live="polite" aria-busy={busy}>
    {busy && <span>Updating execution…</span>}
    {currentStatus === "pausing" && <span>Stopping current action…</span>}
    {currentStatus === "interrupted" && <span>One action interrupted</span>}
    {currentStatus === "manual_required" && <span>Workspace needs manual verification before recovery.</span>}
    {error && <span role="alert">{error} </span>}
    {["pausing", "interrupted"].includes(currentStatus) && ["continue", "restart", "discard"].map((action) => <button key={action} type="button" className="claude-retry" disabled={busy || currentStatus === "pausing" || !current?.[`can_${action}`]} onClick={() => void decide(action)} aria-label={action === "continue" ? "Continue interrupted action" : action === "restart" ? "Restart interrupted action" : "Discard interrupted action"}>{action === "continue" ? "Continue" : action === "restart" ? "Restart" : "Discard"}</button>)}
    {currentStatus === "manual_required" && current?.can_discard && <button type="button" className="claude-retry" disabled={busy} onClick={() => void decide("discard")}>Discard</button>}
  </div>;
}

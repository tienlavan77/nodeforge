// Lets owners pause and recover interrupted System Engineer work without blindly repeating Git changes.
"use client";

import { useEffect, useRef, useState } from "react";

// Shows durable execution status and requires a second Escape key press to pause active work.
export function SystemExecutionControls({ client, projectId, conversationId, executionId, agentTyping, onPause }) {
  const [executions, setExecutions] = useState([]);
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastEscape = useRef(0);
  const inFlight = useRef(false);
  const scopedExecutions = executions.filter((entry) => entry.conversation_id === conversationId);
  const current = scopedExecutions.find((entry) => entry.status === "running")
    ?? scopedExecutions.find((entry) => entry.status === "pausing")
    ?? scopedExecutions.find((entry) => ["interrupted", "manual_required"].includes(entry.status));
  const currentId = current?.execution_id;
  const currentStatus = current?.status;

  useEffect(() => {
    if (!conversationId) { setExecutions([]); return undefined; }
    let mounted = true;
    // Refreshes the owner's recovery options when a turn or Control API process changes.
    const refresh = async () => {
      try {
        const response = await client.listOwnerExecutions(projectId, conversationId);
        if (mounted) {
          setExecutions((previous) => (response.items ?? []).map((entry) => previous.some((item) => item.execution_id === entry.execution_id && item.status === "pausing") && entry.status === "running" ? { ...entry, status: "pausing" } : entry));
          setError("");
        }
      } catch (reason) { if (mounted) setError(reason.message ?? "Unable to load executions."); }
    };
    void refresh();
    return () => { mounted = false; };
  }, [client, projectId, conversationId]);

  useEffect(() => {
    if (currentStatus !== "running" && (current || !agentTyping)) return undefined;
    // Requires two Escape presses within three seconds to stop the current agent turn.
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.repeat || event.isComposing || event.nativeEvent?.isComposing || event.target?.closest?.('[role="dialog"], [aria-modal="true"], .conversations-accordion-rename-input')) return;
      const now = Date.now();
      if (now - lastEscape.current > 3000) {
        lastEscape.current = now;
        setHint("Press Esc again within 3 seconds to pause the System Engineer.");
        return;
      }
      lastEscape.current = 0;
      setHint("");
      event.preventDefault();
      void decide("pause");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); lastEscape.current = 0; setHint(""); };
  }, [client, projectId, conversationId, currentId, currentStatus, agentTyping, busy, onPause]);

  // Sends one pause or recovery decision and keeps the visible state in sync.
  async function decide(action) {
    if (inFlight.current || !conversationId) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const record = action === "pause" && executionId && agentTyping ? { conversation_id: conversationId, execution_id: executionId, status: "running" } : current;
      if (!record || (action === "pause" && record.status !== "running")) throw new Error("No active System Engineer execution to pause yet.");
      await client.decideOwnerExecution(projectId, conversationId, record.execution_id, action);
      setExecutions((previous) => {
        const status = action === "pause" ? "pausing" : action === "continue" ? "running" : action === "restart" ? "restarted" : "discarded";
        return previous.some((entry) => entry.execution_id === record.execution_id) ? previous.map((entry) => entry.execution_id === record.execution_id ? { ...entry, status } : entry) : [...previous, { ...record, status }];
      });
      if (action === "pause") onPause?.(false);
    } catch (reason) { setError(reason.message ?? "Unable to update execution."); }
    finally { inFlight.current = false; setBusy(false); }
  }

  if (!current && !agentTyping && !error) return null;
  return <div className="claude-chat-status" role="status" aria-live="polite">
    {(currentStatus === "running" || (!current && agentTyping)) && <button type="button" className="claude-retry" disabled={busy || !conversationId} onClick={() => void decide("pause")}>Pause</button>}
    {currentStatus === "pausing" && <><span>Pausing System Engineer…</span><button type="button" className="claude-retry" onClick={() => void client.listOwnerExecutions(projectId, conversationId).then((response) => { setExecutions((response.items ?? []).map((entry) => entry.execution_id === currentId && entry.status === "running" ? { ...entry, status: "pausing" } : entry)); setError(""); }).catch((reason) => setError(reason.message ?? "Unable to check status."))}>Check status</button></>}
    {currentStatus === "interrupted" && <span>System Engineer paused. Choose how to proceed. </span>}
    {currentStatus === "manual_required" && <span>Workspace needs manual verification before recovery.</span>}
    {hint && <span>{hint} </span>}
    {error && <span>{error} </span>}
    {currentStatus === "interrupted" && ["continue", "restart", "discard"].map((action) => <button key={action} type="button" className="claude-retry" disabled={busy} onClick={() => void decide(action)}>{action === "continue" ? "Continue" : action === "restart" ? "Restart" : "Discard"}</button>)}
  </div>;
}

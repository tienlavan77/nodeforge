// Lets owners pause and recover interrupted System Engineer work without blindly repeating Git changes.
"use client";

import { useEffect, useRef, useState } from "react";

// Shows durable execution status and requires a second Escape key press to pause active work.
export function SystemExecutionControls({ client, projectId, conversationId, onPause }) {
  const [executions, setExecutions] = useState([]);
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lastEscape = useRef(0);
  const scopedExecutions = executions.filter((entry) => entry.conversation_id === conversationId);
  const current = scopedExecutions.find((entry) => entry.status === "running") ?? scopedExecutions.find((entry) => entry.status === "interrupted");
  const currentId = current?.execution_id;
  const currentStatus = current?.status;

  useEffect(() => {
    if (!conversationId) { setExecutions([]); return undefined; }
    let mounted = true;
    // Refreshes the owner's recovery options when a turn or Control API process changes.
    const refresh = async () => {
      try {
        const response = await client.listOwnerExecutions(projectId, conversationId);
        if (mounted) { setExecutions(response.items ?? []); setError(""); }
      } catch (reason) { if (mounted) setError(reason.message ?? "Unable to load executions."); }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => { mounted = false; clearInterval(interval); };
  }, [client, projectId, conversationId]);

  useEffect(() => {
    if (!currentId || currentStatus !== "running") return undefined;
    // Requires two Escape presses within three seconds to stop the current agent turn.
    const onKeyDown = (event) => {
      if (event.key !== "Escape" || event.repeat || event.isComposing) return;
      const now = Date.now();
      if (now - lastEscape.current > 3000) {
        lastEscape.current = now;
        setHint("Press Esc again within 3 seconds to pause the System Engineer.");
        return;
      }
      lastEscape.current = 0;
      setHint("");
      event.preventDefault();
      void client.decideOwnerExecution(projectId, conversationId, currentId, "pause")
        .then(() => onPause?.(false))
        .catch((reason) => setError(reason.message ?? "Unable to pause execution."));
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); lastEscape.current = 0; setHint(""); };
  }, [client, projectId, conversationId, currentId, currentStatus, onPause]);

  // Sends the selected recovery decision and updates the visible execution state.
  async function decide(action) {
    setBusy(true);
    setError("");
    try {
      await client.decideOwnerExecution(projectId, conversationId, currentId, action);
      setExecutions((previous) => previous.map((entry) => entry.execution_id === currentId ? { ...entry, status: action === "continue" ? "running" : action === "restart" ? "restarted" : "discarded" } : entry));
    } catch (reason) { setError(reason.message ?? "Recovery requires manual reconciliation."); }
    finally { setBusy(false); }
  }

  if (!current && !error) return null;
  return <div className="claude-chat-status" role="status" aria-live="polite">
    {currentStatus === "interrupted" && <span>System Engineer interrupted. Check workspace before continuing. </span>}
    {hint && <span>{hint} </span>}
    {error && <span>{error} </span>}
    {currentStatus === "interrupted" && ["continue", "restart", "discard"].map((action) => <button key={action} type="button" className="claude-retry" disabled={busy} onClick={() => void decide(action)}>{action === "continue" ? "Continue" : action === "restart" ? "Restart" : "Discard"}</button>)}
  </div>;
}

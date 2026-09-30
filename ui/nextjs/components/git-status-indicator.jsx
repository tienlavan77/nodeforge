// Shows a bounded project Git status summary in the canonical workspace.
"use client";

import { useCallback, useEffect, useState } from "react";
import { formatGitStatus } from "../lib/git-status-view.js";

// Loads a read-only Git summary and lets the owner retry unavailable status.
export function GitStatusIndicator({ client, projectId }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setStatus(await client.getGitStatus(projectId)); }
    catch (error) { console.error("Git status load failed", error); setStatus(null); }
    finally { setLoading(false); }
  }, [client, projectId]);

  useEffect(() => { void refresh(); }, [refresh]);
  const view = formatGitStatus(status);
  return <div className={`workspace-git-status is-${view.state}`} aria-live="polite">
    <span>GIT</span><strong>{loading ? "Loading…" : view.label}</strong>
    {view.branch && <small>{view.branch}</small>}
    {view.changed > 0 && view.state !== "dirty" && <small>{view.changed} changed</small>}
    {view.state === "unavailable" && !loading && <button type="button" onClick={refresh}>Retry</button>}
  </div>;
}

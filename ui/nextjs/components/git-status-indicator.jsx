// Shows a bounded project Git status summary in the canonical workspace.
"use client";

import { useCallback, useEffect, useState } from "react";
import { formatGitStatus } from "../lib/git-status-view.js";

// Loads a read-only Git summary and lets the owner retry unavailable status.
export function GitStatusIndicator({ client, projectId }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const refresh = useCallback(async () => {
    setLoading(true);
    try { setStatus(await client.getGitStatus(projectId)); }
    catch (error) { console.error("Git status load failed", error); setStatus(null); }
    finally { setLoading(false); }
  }, [client, projectId]);

  // Commit every changed workspace file and push after the owner confirms the operation.
  async function commitAndPush(changed) {
    if (saving || !window.confirm(`Commit and push all ${changed} changed files?`)) return;
    setSaving(true);
    setActionMessage("");
    try {
      const result = await client.commitAndPush(projectId, "Update project changes");
      setActionMessage(result.status === "pushed" ? `Pushed ${result.changed_files} changed files.` : `Commit ${result.commit_sha.slice(0, 8)} created, but push failed.`);
    } catch (error) {
      console.error("Git commit and push failed", error);
      setActionMessage(error.message || "Git commit and push failed.");
    } finally {
      await refresh();
      setSaving(false);
    }
  }

  useEffect(() => { void refresh(); }, [refresh]);
  const view = formatGitStatus(status);
  return <div className={`workspace-git-status is-${view.state}`} aria-live="polite">
    <span>GIT</span><strong>{loading ? "Loading…" : view.label}</strong>
    {view.branch && <small>{view.branch}</small>}
    {view.changed > 0 && view.state !== "dirty" && <small>{view.changed} changed</small>}
    {view.changed > 0 && <button type="button" onClick={() => commitAndPush(view.changed)} disabled={loading || saving} title="Commit and push all changed files">{saving ? "Working…" : "Commit & push"}</button>}
    {view.state === "unavailable" && !loading && <button type="button" onClick={refresh}>Retry</button>}
    {actionMessage && <small className="workspace-git-action-result" role="status">{actionMessage}</small>}
  </div>;
}

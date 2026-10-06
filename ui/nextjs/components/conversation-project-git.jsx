// Keeps project Git status and owner commit controls visible without loading sprint or plan data.
"use client";

import { GitStatusIndicator } from "./git-status-indicator.jsx";

// Shows the project identity and Git actions in both role-scoped conversation workspaces.
export function ConversationProjectGit({ client, projectId }) {
  return <div className="home-plan-approval-notice" role="status"><div className="home-plan-approval-project">
    <span className="home-plan-project-icon" aria-label="Project"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l1.7 2H20.5v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z" /></svg></span>
    <strong>NodeForge</strong><span className="home-plan-git-icon" aria-hidden="true">⌘</span>
    <GitStatusIndicator client={client} projectId={projectId} />
  </div></div>;
}

// Keeps the conversation statusbar slot while ConversationHeaderProjectGit renders project identity and Git status in the page header.
"use client";

import { useSyncExternalStore } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { GitStatusIndicator } from "./git-status-indicator.jsx";
import { getProjectDirectory, subscribeProjectDirectory } from "../lib/project-directory-client.js";
import { getProjectSelection, subscribeProjectSelection } from "../lib/project-selection.js";

const EMPTY_CATALOG = { projects: [] };

// Business purpose: resolves the human-readable project name from the active project catalog or selection store so conversation headers show the friendly workspace name when available and fall back to `projectId` otherwise.
// Technical description: checks `directoryProjects` and `selectionProjects` for an entry matching `projectId` on `project_id` or `projectId`, returning its trimmed `name` or `title` before falling back to `projectId`.
export function resolveConversationProjectName(projectId, directoryProjects = [], selectionProjects = []) {
  const id = String(projectId ?? "").trim();
  for (const list of [directoryProjects, selectionProjects]) {
    if (!Array.isArray(list)) continue;
    const match = list.find((item) => (item?.project_id ?? item?.projectId) === id);
    const label = String(match?.name ?? match?.title ?? "").trim();
    if (label) return label;
  }
  return id;
}

// Business purpose: displays the active project's resolved name and live Git status indicator on the right side of the Architecture and System conversation page headers.
// Technical description: subscribes to the project directory and selection stores to derive the current project title and mounts a single `GitStatusIndicator` bound to `client` and `projectId`.
export function ConversationHeaderProjectGit({ client, projectId }) {
  const directory = useSyncExternalStore(subscribeProjectDirectory, getProjectDirectory, () => EMPTY_CATALOG);
  const selection = useSyncExternalStore(subscribeProjectSelection, getProjectSelection, () => EMPTY_CATALOG);
  const projectName = resolveConversationProjectName(projectId, directory?.projects, selection?.projects);
  return <div className="home-plan-approval-project claude-chat-header-project" aria-label="Project and Git status">
    <span className="home-plan-project-icon" aria-label="Project"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3.5 6.5h6l1.7 2H20.5v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z" /></svg></span>
    <strong className="claude-chat-header-project-name" title={projectName}>{projectName}</strong>
    <span className="home-plan-git-icon" aria-hidden="true">⌘</span>
    <GitStatusIndicator client={client} projectId={projectId} />
  </div>;
}

export function ConversationProjectGit({ children }) {
  return <div className="home-plan-approval-notice" role="status">{children}</div>;
}

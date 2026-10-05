// Keep sidebar navigation available without resetting conversations, agents, or streaming.
"use client";

import { useEffect, useRef, useState } from "react";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import Link from "next/link";
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
import { ResponsiveWorkspaceRegion } from "./responsive-workspace-region.jsx";
import { readSidebarPreference, writeSidebarPreference } from "../lib/sidebar-preference.js";

// Shows a recognizable symbol for each persistent workspace navigation action.
// eslint-disable-next-line no-unused-vars -- Next resolves this component reference in JSX.
function SidebarNavigationIcon({ name }) {
  const paths = {
    conversation: <path d="M5 5.5h14v9H9l-4 4v-13Z" />,
    projects: <path d="M3.5 6.5h6l1.7 2H20.5v9.7a1.8 1.8 0 0 1-1.8 1.8H5.3a1.8 1.8 0 0 1-1.8-1.8V6.5Z" />,
    agents: <><circle cx="12" cy="8" r="3" /><path d="M5.5 20c.5-3.3 2.7-5 6.5-5s6 1.7 6.5 5" /></>,
    architecture: <><circle cx="12" cy="12" r="7" /><path d="M12 5v14M5 12h14" /></>,
    coding: <path d="m9 7-5 5 5 5M15 7l5 5-5 5M13.5 5 10.5 19" />,
  };
  return <svg className="claude-sidebar-navigation-icon" aria-hidden="true" viewBox="0 0 24 24">{paths[name]}</svg>;
}

// Present a persistent desktop sidebar and a keyboard-accessible mobile navigation rail.
export function ConversationSidebar({ open, onOpen, onClose, agentSectionTitle = "Architecture", architectureLabel, architectureControl, projects = [], selectedProjectId, onProjectChange, onNewConversation, children }) {
  const [collapsed, setCollapsed] = useState(false);
  const panelRef = useRef(null);

  useEffect(() => { setCollapsed(readSidebarPreference()); }, []);

  // Change only the sidebar presentation and persist the user's device preference.
  function changeCollapsed(next) {
    setCollapsed(next);
    writeSidebarPreference(next);
  }

  // Reopen conversation navigation without changing the active conversation.
  function reopen() {
    changeCollapsed(false);
    onOpen();
  }

  // Reuse the existing new-conversation workflow while keeping its state mounted.
  function newConversation() {
    onNewConversation?.();
  }

  return <>
    <nav className={`conversation-mobile-rail${open ? " is-open" : ""}`} aria-label="Collapsed conversation navigation">
      <button type="button" onClick={reopen} aria-label="Open conversations sidebar" title="Open conversations sidebar">N</button>
      <button type="button" onClick={newConversation} aria-label="New chat" title="New chat">＋</button>
    </nav>
    <ResponsiveWorkspaceRegion name="conversations" title="Conversations" breakpoint={640} open={open} onClose={onClose}>
      <section ref={panelRef} className={`home-conversations-panel home-panel conversation-sidebar${collapsed ? " is-collapsed" : ""}`} aria-label="Conversations">
        <div className="home-sidebar-brand">
          <div className="home-sidebar-wordmark"><span className="home-sidebar-logo" aria-hidden="true">N</span><span className="home-sidebar-name">NodeForge</span></div>
          <button type="button" className="home-sidebar-collapse" onClick={() => { changeCollapsed(!collapsed); if (!collapsed) onClose(); }} aria-label={collapsed ? "Open conversations sidebar" : "Collapse conversations sidebar"} aria-expanded={!collapsed} title={collapsed ? "Open conversations sidebar" : "Collapse conversations sidebar"}>
            <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
              <path d="M9 5v14" />
              {collapsed ? <path d="m14 9 3 3-3 3" /> : <path d="m16.5 9-3 3 3 3" />}
            </svg>
          </button>
        </div>
        <nav className="claude-sidebar-navigation" aria-label="Workspace navigation">
          <details className="claude-sidebar-architecture">
            <summary title={architectureLabel ? `${agentSectionTitle}: ${architectureLabel}` : agentSectionTitle}>
              <span className="claude-architecture-summary-icon"><SidebarNavigationIcon name={agentSectionTitle === "System" || agentSectionTitle === "Code" ? "coding" : "architecture"} /><span className="claude-architecture-selected-avatar" aria-hidden="true">{(architectureLabel ?? "?").trim().slice(0, 1).toUpperCase()}</span></span>
              <span>{agentSectionTitle}</span>
            </summary>
            {architectureControl}
          </details>
          <button type="button" onClick={newConversation} title="New conversation"><SidebarNavigationIcon name="conversation" /><span>New conversation</span></button>
          <details className="claude-sidebar-projects" open>
            <summary title="Projects"><SidebarNavigationIcon name="projects" /><span>Projects</span></summary>
            <div className="claude-sidebar-project-list">
              {projects.map((project) => <button type="button" className={`claude-sidebar-project-link${project.id === selectedProjectId ? " is-selected" : ""}`} key={project.id} onClick={() => onProjectChange?.(project.id)} aria-current={project.id === selectedProjectId ? "page" : undefined}><span>{project.name}</span>{project.id === selectedProjectId && <i aria-label="Selected project">✓</i>}</button>)}
            </div>
          </details>
          <Link href="/" title="Architecture" aria-current={!['System', 'Code'].includes(agentSectionTitle) ? "page" : undefined}><SidebarNavigationIcon name="architecture" /><span>Architecture</span></Link>
          <Link href="/agents" title="Agents"><SidebarNavigationIcon name="agents" /><span>Agents</span></Link>
          <Link href="/system" title="System" aria-current={agentSectionTitle === "System" ? "page" : undefined}><SidebarNavigationIcon name="coding" /><span>System</span></Link>
          <Link href="/code" title="Code" aria-current={agentSectionTitle === "Code" ? "page" : undefined}><SidebarNavigationIcon name="coding" /><span>Code</span></Link>
        </nav>
        {children}
      </section>
    </ResponsiveWorkspaceRegion>
    <style jsx global>{`
      .conversation-sidebar .home-sidebar-collapse { cursor: pointer; }
      .conversation-mobile-rail button { cursor: pointer; color: var(--app-text); background: var(--app-button-bg); border: 1px solid var(--app-button-border); border-radius: 6px; min-width: 40px; min-height: 40px; }
      .conversation-sidebar button:focus-visible, .conversation-mobile-rail button:focus-visible { outline: 2px solid var(--app-text); outline-offset: 2px; }
      .conversation-mobile-rail { display: none; }
      .conversation-sidebar.is-collapsed { padding: 4px; overflow: visible; position: relative; }
      .conversation-sidebar.is-collapsed .home-sidebar-brand { justify-content: center; }
      .conversation-sidebar.is-collapsed .home-sidebar-wordmark, .conversation-sidebar.is-collapsed .claude-sidebar-footer, .conversation-sidebar.is-collapsed .conversations-accordion { display: none; }
      .home-workspace:has(.conversation-sidebar.is-collapsed) { grid-template-columns: 42px minmax(0, 38fr) minmax(0, 23fr) minmax(0, 20fr); }
      @media (min-width: 641px) and (max-width: 900px) {
        .home-workspace:has(.conversation-sidebar.is-collapsed) { grid-template-columns: 56px minmax(0, 52fr) minmax(160px, 24fr); }
      }
      @media (max-width: 640px) {
        .home-workspace:has(.conversation-sidebar) { grid-template-columns: minmax(0, 1fr); padding-left: 56px; }
        .conversation-mobile-rail { display: flex; position: fixed; left: 0; top: 120px; bottom: 0; width: 56px; flex-direction: column; align-items: center; gap: 12px; padding-top: 12px; background: var(--app-panel); z-index: 20; }
        .conversation-mobile-rail.is-open { visibility: hidden; }
        .home-workspace .responsive-region--conversations.is-drawer.is-open { justify-content: flex-start; }
      }
    `}</style>
  </>;
}

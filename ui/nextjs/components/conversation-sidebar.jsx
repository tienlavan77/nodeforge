// Keep sidebar navigation available without resetting conversations, agents, or streaming.
"use client";

import { useEffect, useRef, useState } from "react";
import { ResponsiveWorkspaceRegion } from "./responsive-workspace-region.jsx";
import { readSidebarPreference, writeSidebarPreference } from "../lib/sidebar-preference.js";

// Present a persistent desktop sidebar and a keyboard-accessible mobile navigation rail.
export function ConversationSidebar({ open, onOpen, onClose, selectedAgentLabel, children }) {
  const [collapsed, setCollapsed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const panelRef = useRef(null);
  const architectureRef = useRef(null);
  const tooltip = `Architecture: ${selectedAgentLabel || "No agent selected"}`;

  useEffect(() => { setCollapsed(readSidebarPreference()); }, []);
  useEffect(() => {
    if (selecting) panelRef.current?.querySelector("select")?.focus();
  }, [selecting, open]);

  // Change only the sidebar presentation and persist the user's device preference.
  function changeCollapsed(next) {
    setCollapsed(next);
    setSelecting(false);
    writeSidebarPreference(next);
  }

  // Reopen conversation navigation without changing the active conversation.
  function reopen() {
    changeCollapsed(false);
    onOpen();
  }

  // Expose the existing agent selector without changing the selected agent.
  function showArchitecture() {
    setSelecting(true);
    onOpen();
  }

  // Reuse the existing new-conversation workflow while keeping its state mounted.
  function newConversation() {
    panelRef.current?.querySelector(".conversations-accordion-new")?.click();
  }

  return <>
    <nav className={`conversation-mobile-rail${open ? " is-open" : ""}`} aria-label="Collapsed conversation navigation">
      <button type="button" onClick={reopen} aria-label="Open conversations sidebar" title="Open conversations sidebar">N</button>
      <button type="button" onClick={newConversation} aria-label="New chat" title="New chat">＋</button>
      <button type="button" onClick={showArchitecture} aria-label={tooltip} title={tooltip}>◇</button>
    </nav>
    <ResponsiveWorkspaceRegion name="conversations" title="Conversations" breakpoint={640} open={open} onClose={onClose}>
      <section ref={panelRef} className={`home-conversations-panel home-panel conversation-sidebar${collapsed ? " is-collapsed" : ""}${selecting ? " is-selecting" : ""}`} aria-label="Conversations"
        onKeyDown={(event) => { if (event.key === "Escape" && selecting) { event.stopPropagation(); setSelecting(false); architectureRef.current?.focus(); } }}>
        <div className="home-sidebar-brand">
          <button type="button" className="home-sidebar-logo" onClick={() => { changeCollapsed(!collapsed); if (!collapsed) onClose(); }} aria-label={collapsed ? "Open conversations sidebar" : "Collapse conversations sidebar"} aria-expanded={!collapsed} title={collapsed ? "Open conversations sidebar" : "Collapse conversations sidebar"}>N{!collapsed && " ‹"}</button>
        </div>
        <button ref={architectureRef} type="button" className="conversation-architecture-icon" onClick={() => { setSelecting(!selecting); }} aria-label={tooltip} title={tooltip} aria-expanded={!collapsed || selecting} aria-controls="home-architecture-manager-selector">◇</button>
        {children}
      </section>
    </ResponsiveWorkspaceRegion>
    <style jsx global>{`
      .conversation-sidebar .home-sidebar-logo, .conversation-architecture-icon, .conversation-mobile-rail button { cursor: pointer; color: var(--app-text); background: var(--app-button-bg); border: 1px solid var(--app-button-border); border-radius: 6px; min-width: 40px; min-height: 40px; }
      .conversation-sidebar button:focus-visible, .conversation-mobile-rail button:focus-visible { outline: 2px solid var(--app-text); outline-offset: 2px; }
      .conversation-architecture-icon { display: none; }
      .conversation-mobile-rail { display: none; }
      .conversation-sidebar.is-collapsed { padding: 8px; overflow: visible; position: relative; }
      .conversation-sidebar.is-collapsed .home-sidebar-brand { justify-content: center; }
      .conversation-sidebar.is-collapsed .conversation-architecture-icon { display: block; margin: 8px auto; }
      .conversation-sidebar.is-collapsed .home-agent-select-row, .conversation-sidebar.is-collapsed .conversations-accordion-panel { display: none; }
      .conversation-sidebar.is-collapsed .conversations-accordion-new { font-size: 0; min-width: 40px; min-height: 40px; padding: 0; }
      .conversation-sidebar.is-collapsed .conversations-accordion-new::after { content: "＋"; font-size: 24px; }
      .conversation-sidebar.is-collapsed.is-selecting .home-agent-select-row { display: block; position: absolute; left: 100%; top: 48px; width: min(280px, calc(100vw - 72px)); max-width: calc(100vw - 72px); box-sizing: border-box; padding: 12px; z-index: 950; background: var(--app-panel); border: 1px solid var(--app-border); }
      .conversation-sidebar.is-collapsed.is-selecting .home-agent-select { width: 100%; min-width: 0; max-width: 100%; }
      .home-workspace:has(.conversation-sidebar.is-collapsed) { grid-template-columns: 56px minmax(0, 38fr) minmax(0, 23fr) minmax(0, 20fr); }
      @media (min-width: 641px) and (max-width: 900px) {
        .home-workspace:has(.conversation-sidebar.is-collapsed) { grid-template-columns: 56px minmax(0, 52fr) minmax(160px, 24fr); }
      }
      @media (max-width: 640px) {
        .home-workspace:has(.conversation-sidebar) { grid-template-columns: minmax(0, 1fr); padding-left: 56px; }
        .conversation-mobile-rail { display: flex; position: fixed; left: 0; top: 120px; bottom: 0; width: 56px; flex-direction: column; align-items: center; gap: 12px; padding-top: 12px; background: var(--app-panel); z-index: 20; }
        .conversation-mobile-rail.is-open { visibility: hidden; }
        .home-workspace .responsive-region--conversations.is-drawer.is-open { justify-content: flex-start; }
        .conversation-sidebar.is-collapsed.is-selecting .home-agent-select-row { position: static; width: auto; }
      }
    `}</style>
  </>;
}
